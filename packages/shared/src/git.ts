import type {
  VcsRef,
  SourceControlProviderInfo,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "@t3tools/contracts";
import { DEFAULT_WORKTREE_BRANCH_PREFIX } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import { detectSourceControlProviderFromRemoteUrl } from "./sourceControl.ts";

export { DEFAULT_WORKTREE_BRANCH_PREFIX };

// Canonical token is 8 hex chars.
const TEMPORARY_WORKTREE_TOKEN_PATTERN = /^[0-9a-f]{8}$/;
// Older mobile builds generated a full UUID via Crypto.randomUUID() (always RFC
// 4122 v4), so that exact shape — version nibble `4`, variant nibble `[89ab]` —
// stays eligible for branch regeneration, without loosening beyond what was ever
// generated. Only honored under the built-in prefix; see below.
const LEGACY_UUID_WORKTREE_TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Sanitize an arbitrary string into a valid, lowercase git refName fragment.
 * Strips quotes, collapses separators, limits to 64 chars.
 */
export function sanitizeBranchFragment(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/^[./\s_-]+|[./\s_-]+$/g, "");

  const branchFragment = normalized
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  return branchFragment.length > 0 ? branchFragment : "update";
}

/**
 * Sanitize a string into a `feature/…` refName name.
 * Preserves an existing `feature/` prefix or slash-separated namespace.
 */
export function sanitizeFeatureBranchName(raw: string): string {
  const sanitized = sanitizeBranchFragment(raw);
  if (sanitized.includes("/")) {
    return sanitized.startsWith("feature/") ? sanitized : `feature/${sanitized}`;
  }
  return `feature/${sanitized}`;
}

const AUTO_FEATURE_BRANCH_FALLBACK = "feature/update";

/**
 * Resolve a unique `feature/…` refName name that doesn't collide with
 * any existing refName. Appends a numeric suffix when needed.
 */
export function resolveAutoFeatureBranchName(
  existingBranchNames: readonly string[],
  preferredBranch?: string,
): string {
  const preferred = preferredBranch?.trim();
  const resolvedBase = sanitizeFeatureBranchName(
    preferred && preferred.length > 0 ? preferred : AUTO_FEATURE_BRANCH_FALLBACK,
  );
  const existingNames = new Set(existingBranchNames.map((refName) => refName.toLowerCase()));

  if (!existingNames.has(resolvedBase)) {
    return resolvedBase;
  }

  let suffix = 2;
  while (existingNames.has(`${resolvedBase}-${suffix}`)) {
    suffix += 1;
  }

  return `${resolvedBase}-${suffix}`;
}

/**
 * Strip the remote prefix from a remote ref such as `origin/feature/demo`.
 */
export function deriveLocalBranchNameFromRemoteRef(branchName: string): string {
  const firstSeparatorIndex = branchName.indexOf("/");
  if (firstSeparatorIndex <= 0 || firstSeparatorIndex === branchName.length - 1) {
    return branchName;
  }
  return branchName.slice(firstSeparatorIndex + 1);
}

/**
 * Normalize a user-configured worktree branch prefix into a refName-safe
 * namespace. Returns `""` when the prefix is blank or reduces to nothing,
 * which means worktree branches are created without any namespace.
 */
export function sanitizeWorktreeBranchPrefix(rawPrefix: string): string {
  return rawPrefix
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .slice(0, 32)
    .replace(/^[./_-]+|[./_-]+$/g, "");
}

function applyWorktreeBranchPrefix(sanitizedPrefix: string, fragment: string): string {
  return sanitizedPrefix.length === 0 ? fragment : `${sanitizedPrefix}/${fragment}`;
}

/**
 * Strip `<prefix>/` from the front of a branch name, or `null` when it isn't there.
 * An empty prefix matches nothing — a bare branch has no prefix to remove.
 */
function stripWorktreeBranchPrefix(branchName: string, sanitizedPrefix: string): string | null {
  if (sanitizedPrefix.length === 0) {
    return null;
  }
  const namespace = `${sanitizedPrefix}/`;
  return branchName.startsWith(namespace) ? branchName.slice(namespace.length) : null;
}

export function buildTemporaryWorktreeBranchName(
  randomHex: (byteLength: number) => string,
  rawPrefix: string = DEFAULT_WORKTREE_BRANCH_PREFIX,
): string {
  // Normalize to exactly 8 lowercase hex chars so a UUID-shaped callback
  // still produces the canonical temporary branch form.
  const token = randomHex(4)
    .toLowerCase()
    .replace(/[^0-9a-f]/g, "")
    .slice(0, 8);
  return applyWorktreeBranchPrefix(sanitizeWorktreeBranchPrefix(rawPrefix), token);
}

/**
 * The placeholder token of an auto-generated worktree branch, or `null` when
 * the branch isn't one. Recognizes the configured prefix *and* the built-in
 * `t3code` one, so worktrees created before the prefix changed keep working.
 *
 * The legacy UUID form is only ever accepted under the built-in prefix, because
 * that is the only place older clients ever generated it — accepting it under
 * an arbitrary prefix would mistake a real `wip/<uuid>` branch for a placeholder.
 */
function temporaryWorktreeBranchToken(refName: string, rawPrefix: string): string | null {
  const normalized = refName.trim().toLowerCase();
  const configuredPrefix = sanitizeWorktreeBranchPrefix(rawPrefix);

  for (const prefix of new Set([configuredPrefix, DEFAULT_WORKTREE_BRANCH_PREFIX])) {
    const token = prefix.length === 0 ? normalized : stripWorktreeBranchPrefix(normalized, prefix);
    if (token === null) {
      continue;
    }
    if (TEMPORARY_WORKTREE_TOKEN_PATTERN.test(token)) {
      return token;
    }
    if (
      prefix === DEFAULT_WORKTREE_BRANCH_PREFIX &&
      LEGACY_UUID_WORKTREE_TOKEN_PATTERN.test(token)
    ) {
      return token;
    }
  }

  return null;
}

/**
 * Whether a branch is still an auto-generated worktree placeholder, and so is
 * safe to rename once a real branch name has been generated.
 *
 * When the configured prefix is empty, a bare `<8 hex>` branch counts as
 * temporary — that is the shape this app generates in that mode, so it has to.
 */
export function isTemporaryWorktreeBranch(
  refName: string,
  rawPrefix: string = DEFAULT_WORKTREE_BRANCH_PREFIX,
): boolean {
  return temporaryWorktreeBranchToken(refName, rawPrefix) !== null;
}

/**
 * Move a client-supplied placeholder branch under this server's configured
 * prefix, leaving any deliberately-named branch untouched.
 *
 * Clients mint the placeholder before the server sees it, and a client can be
 * pointed at an environment whose prefix differs from the one it knows about
 * (or hold a snapshot taken before the setting changed). The server is the only
 * party that knows its own prefix for certain, so it re-namespaces on the way in.
 */
export function renamespaceTemporaryWorktreeBranch(
  refName: string,
  rawPrefix: string = DEFAULT_WORKTREE_BRANCH_PREFIX,
): string {
  const token = temporaryWorktreeBranchToken(refName, rawPrefix);
  if (token === null) {
    return refName;
  }

  // Collapse a legacy UUID token to the canonical 8 hex chars, matching what
  // `buildTemporaryWorktreeBranchName` emits, so the result stays recognizable
  // as a placeholder under the new prefix.
  const canonicalToken = token.replace(/-/g, "").slice(0, 8);
  return applyWorktreeBranchPrefix(sanitizeWorktreeBranchPrefix(rawPrefix), canonicalToken);
}

/**
 * Turn a model-generated branch suggestion into the final worktree branch name,
 * re-namespacing it under the configured prefix. Tolerates a suggestion that
 * already carries the configured or built-in prefix so it isn't doubled up.
 */
export function buildGeneratedWorktreeBranchName(
  raw: string,
  rawPrefix: string = DEFAULT_WORKTREE_BRANCH_PREFIX,
): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    // Quotes come off before prefix detection: a suggestion like `"t3code/fix"`
    // would otherwise fail the prefix check and end up double-namespaced.
    .replace(/['"`]/g, "")
    .replace(/^refs\/heads\//, "");
  const sanitizedPrefix = sanitizeWorktreeBranchPrefix(rawPrefix);
  const withoutPrefix =
    stripWorktreeBranchPrefix(normalized, sanitizedPrefix) ??
    stripWorktreeBranchPrefix(normalized, DEFAULT_WORKTREE_BRANCH_PREFIX) ??
    normalized;

  return applyWorktreeBranchPrefix(sanitizedPrefix, sanitizeBranchFragment(withoutPrefix));
}

/**
 * Normalize a git remote URL into a stable comparison key.
 */
export function normalizeGitRemoteUrl(value: string): string {
  const normalized = value
    .trim()
    .replace(/\/+$/g, "")
    .replace(/\.git$/i, "")
    .toLowerCase();

  if (/^(?:ssh|https?|git):\/\//i.test(normalized)) {
    try {
      const url = new URL(normalized);
      const repositoryPath = url.pathname
        .split("/")
        .filter((segment) => segment.length > 0)
        .join("/");
      if (url.hostname && repositoryPath.includes("/")) {
        return `${url.hostname}/${repositoryPath}`;
      }
    } catch {
      return normalized;
    }
  }

  const scpStyleHostAndPath = /^git@([^:/\s]+)[:/]([^/\s]+(?:\/[^/\s]+)+)$/i.exec(normalized);
  if (scpStyleHostAndPath?.[1] && scpStyleHostAndPath[2]) {
    return `${scpStyleHostAndPath[1]}/${scpStyleHostAndPath[2]}`;
  }

  return normalized;
}

/**
 * Best-effort parse of a GitHub `owner/repo` identifier from common remote URL shapes.
 */
export function parseGitHubRepositoryNameWithOwnerFromRemoteUrl(url: string | null): string | null {
  const trimmed = url?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }

  const match =
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/|git:\/\/github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(
      trimmed,
    );
  const repositoryNameWithOwner = match?.[1]?.trim() ?? "";
  return repositoryNameWithOwner.length > 0 ? repositoryNameWithOwner : null;
}

function deriveLocalBranchNameCandidatesFromRemoteRef(
  branchName: string,
  remoteName?: string,
): ReadonlyArray<string> {
  const candidates = new Set<string>();
  const firstSlashCandidate = deriveLocalBranchNameFromRemoteRef(branchName);
  if (firstSlashCandidate.length > 0) {
    candidates.add(firstSlashCandidate);
  }

  if (remoteName) {
    const remotePrefix = `${remoteName}/`;
    if (branchName.startsWith(remotePrefix) && branchName.length > remotePrefix.length) {
      candidates.add(branchName.slice(remotePrefix.length));
    }
  }

  return [...candidates];
}

/**
 * Hide `origin/*` remote refs when a matching local refName already exists.
 */
export function dedupeRemoteBranchesWithLocalMatches(
  refs: ReadonlyArray<VcsRef>,
): ReadonlyArray<VcsRef> {
  const localBranchNames = new Set(
    Arr.filterMap(refs, (refName) =>
      refName.isRemote ? Result.failVoid : Result.succeed(refName.name),
    ),
  );

  return refs.filter((refName) => {
    if (!refName.isRemote) {
      return true;
    }

    if (refName.remoteName !== "origin") {
      return true;
    }

    const localBranchCandidates = deriveLocalBranchNameCandidatesFromRemoteRef(
      refName.name,
      refName.remoteName,
    );
    return !localBranchCandidates.some((candidate) => localBranchNames.has(candidate));
  });
}

export function detectSourceControlProviderFromGitRemoteUrl(
  remoteUrl: string,
): SourceControlProviderInfo | null {
  return detectSourceControlProviderFromRemoteUrl(remoteUrl);
}

const EMPTY_GIT_STATUS_REMOTE: VcsStatusRemoteResult = {
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  aheadOfDefaultCount: 0,
  pr: null,
};

export function mergeGitStatusParts(
  local: VcsStatusLocalResult,
  remote: VcsStatusRemoteResult | null,
): VcsStatusResult {
  return {
    ...local,
    ...(remote ?? EMPTY_GIT_STATUS_REMOTE),
  };
}

function toRemoteStatusPart(status: VcsStatusResult): VcsStatusRemoteResult {
  return {
    hasUpstream: status.hasUpstream,
    aheadCount: status.aheadCount,
    behindCount: status.behindCount,
    ...(status.aheadOfDefaultCount === undefined
      ? {}
      : { aheadOfDefaultCount: status.aheadOfDefaultCount }),
    pr: status.pr,
  };
}

function toLocalStatusPart(status: VcsStatusResult): VcsStatusLocalResult {
  return {
    isRepo: status.isRepo,
    ...(status.sourceControlProvider
      ? { sourceControlProvider: status.sourceControlProvider }
      : {}),
    hasPrimaryRemote: status.hasPrimaryRemote,
    isDefaultRef: status.isDefaultRef,
    refName: status.refName,
    hasWorkingTreeChanges: status.hasWorkingTreeChanges,
    workingTree: status.workingTree,
  };
}

export function applyGitStatusStreamEvent(
  current: VcsStatusResult | null,
  event: VcsStatusStreamEvent,
): VcsStatusResult {
  switch (event._tag) {
    case "snapshot":
      return mergeGitStatusParts(event.local, event.remote);
    case "localUpdated":
      return mergeGitStatusParts(event.local, current ? toRemoteStatusPart(current) : null);
    case "remoteUpdated":
      if (current === null) {
        return mergeGitStatusParts(
          {
            isRepo: true,
            hasPrimaryRemote: false,
            isDefaultRef: false,
            refName: null,
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
          },
          event.remote,
        );
      }
      return mergeGitStatusParts(toLocalStatusPart(current), event.remote);
  }
}
