import type { VcsStatusRemoteResult, VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyGitStatusStreamEvent,
  buildGeneratedWorktreeBranchName,
  buildTemporaryWorktreeBranchName,
  isTemporaryWorktreeBranch,
  normalizeGitRemoteUrl,
  parseGitHubRepositoryNameWithOwnerFromRemoteUrl,
  sanitizeWorktreeBranchPrefix,
  DEFAULT_WORKTREE_BRANCH_PREFIX,
} from "./git.ts";

describe("normalizeGitRemoteUrl", () => {
  it("canonicalizes equivalent GitHub remotes across protocol variants", () => {
    expect(normalizeGitRemoteUrl("git@github.com:T3Tools/T3Code.git")).toBe(
      "github.com/t3tools/t3code",
    );
    expect(normalizeGitRemoteUrl("https://github.com/T3Tools/T3Code.git")).toBe(
      "github.com/t3tools/t3code",
    );
    expect(normalizeGitRemoteUrl("ssh://git@github.com/T3Tools/T3Code")).toBe(
      "github.com/t3tools/t3code",
    );
  });

  it("preserves nested group paths for providers like GitLab", () => {
    expect(normalizeGitRemoteUrl("git@gitlab.com:T3Tools/platform/T3Code.git")).toBe(
      "gitlab.com/t3tools/platform/t3code",
    );
    expect(normalizeGitRemoteUrl("https://gitlab.com/T3Tools/platform/T3Code.git")).toBe(
      "gitlab.com/t3tools/platform/t3code",
    );
  });

  it("drops explicit ports from URL-shaped remotes", () => {
    expect(normalizeGitRemoteUrl("https://gitlab.company.com:8443/team/project.git")).toBe(
      "gitlab.company.com/team/project",
    );
    expect(normalizeGitRemoteUrl("ssh://git@gitlab.company.com:2222/team/project.git")).toBe(
      "gitlab.company.com/team/project",
    );
  });
});

describe("parseGitHubRepositoryNameWithOwnerFromRemoteUrl", () => {
  it("extracts the owner and repository from common GitHub remote shapes", () => {
    expect(
      parseGitHubRepositoryNameWithOwnerFromRemoteUrl("git@github.com:T3Tools/T3Code.git"),
    ).toBe("T3Tools/T3Code");
    expect(
      parseGitHubRepositoryNameWithOwnerFromRemoteUrl("https://github.com/T3Tools/T3Code.git"),
    ).toBe("T3Tools/T3Code");
  });
});

describe("isTemporaryWorktreeBranch", () => {
  it("matches the generated temporary worktree refName format", () => {
    expect(
      isTemporaryWorktreeBranch(
        buildTemporaryWorktreeBranchName((byteLength) => {
          expect(byteLength).toBe(4);
          return "DEADBEEF";
        }),
      ),
    ).toBe(true);
  });

  it("matches generated temporary worktree refs", () => {
    expect(isTemporaryWorktreeBranch(`${DEFAULT_WORKTREE_BRANCH_PREFIX}/deadbeef`)).toBe(true);
    expect(isTemporaryWorktreeBranch(` ${DEFAULT_WORKTREE_BRANCH_PREFIX}/deadbeef `)).toBe(true);
    expect(isTemporaryWorktreeBranch(`${DEFAULT_WORKTREE_BRANCH_PREFIX}/DEADBEEF`)).toBe(true);
  });

  it("normalizes a UUID-shaped random callback to the canonical 8-hex form", () => {
    expect(buildTemporaryWorktreeBranchName(() => "f4ae4e0e-f971-4d48-b4f2-9cf0aa54ab12")).toBe(
      `${DEFAULT_WORKTREE_BRANCH_PREFIX}/f4ae4e0e`,
    );
  });

  it("matches legacy UUID-shaped temporary worktree refs from older mobile builds", () => {
    expect(
      isTemporaryWorktreeBranch(
        `${DEFAULT_WORKTREE_BRANCH_PREFIX}/f4ae4e0e-f971-4d48-b4f2-9cf0aa54ab12`,
      ),
    ).toBe(true);
  });

  it("rejects UUID-shaped refs that are not RFC 4122 v4", () => {
    // version nibble is not 4
    expect(
      isTemporaryWorktreeBranch(
        `${DEFAULT_WORKTREE_BRANCH_PREFIX}/f4ae4e0e-f971-1d48-b4f2-9cf0aa54ab12`,
      ),
    ).toBe(false);
    // variant nibble is not [89ab]
    expect(
      isTemporaryWorktreeBranch(
        `${DEFAULT_WORKTREE_BRANCH_PREFIX}/f4ae4e0e-f971-4d48-c4f2-9cf0aa54ab12`,
      ),
    ).toBe(false);
  });

  it("rejects non-temporary refName names", () => {
    expect(isTemporaryWorktreeBranch(`${DEFAULT_WORKTREE_BRANCH_PREFIX}/feature/demo`)).toBe(false);
    expect(isTemporaryWorktreeBranch("main")).toBe(false);
    expect(isTemporaryWorktreeBranch(`${DEFAULT_WORKTREE_BRANCH_PREFIX}/deadbeef-extra`)).toBe(
      false,
    );
  });

  it("matches the configured prefix and still accepts the built-in one", () => {
    expect(isTemporaryWorktreeBranch("wip/deadbeef", "wip")).toBe(true);
    expect(isTemporaryWorktreeBranch(`${DEFAULT_WORKTREE_BRANCH_PREFIX}/deadbeef`, "wip")).toBe(
      true,
    );
    expect(isTemporaryWorktreeBranch("other/deadbeef", "wip")).toBe(false);
  });

  it("treats bare hex refs as temporary only when the prefix is empty", () => {
    expect(isTemporaryWorktreeBranch("deadbeef", "")).toBe(true);
    expect(isTemporaryWorktreeBranch("deadbeef")).toBe(false);
  });
});

describe("sanitizeWorktreeBranchPrefix", () => {
  it("normalizes a prefix into a refName-safe namespace", () => {
    expect(sanitizeWorktreeBranchPrefix("  T3 Code  ")).toBe("t3-code");
    expect(sanitizeWorktreeBranchPrefix("agents/")).toBe("agents");
    expect(sanitizeWorktreeBranchPrefix("my/nested")).toBe("my/nested");
  });

  it("collapses blank or unusable prefixes to no prefix at all", () => {
    expect(sanitizeWorktreeBranchPrefix("")).toBe("");
    expect(sanitizeWorktreeBranchPrefix("   ")).toBe("");
    expect(sanitizeWorktreeBranchPrefix("!!!")).toBe("");
  });
});

describe("buildTemporaryWorktreeBranchName", () => {
  it("applies the configured prefix", () => {
    expect(buildTemporaryWorktreeBranchName(() => "deadbeef", "wip")).toBe("wip/deadbeef");
  });

  it("omits the namespace entirely when the prefix is empty", () => {
    expect(buildTemporaryWorktreeBranchName(() => "deadbeef", "")).toBe("deadbeef");
  });
});

describe("buildGeneratedWorktreeBranchName", () => {
  it("namespaces a generated suggestion under the configured prefix", () => {
    expect(buildGeneratedWorktreeBranchName("Fix Scroll Jump", "wip")).toBe("wip/fix-scroll-jump");
    expect(buildGeneratedWorktreeBranchName("refs/heads/fix-scroll-jump")).toBe(
      `${DEFAULT_WORKTREE_BRANCH_PREFIX}/fix-scroll-jump`,
    );
  });

  it("does not double up a prefix the suggestion already carries", () => {
    expect(buildGeneratedWorktreeBranchName("wip/fix-scroll-jump", "wip")).toBe(
      "wip/fix-scroll-jump",
    );
    expect(
      buildGeneratedWorktreeBranchName(`${DEFAULT_WORKTREE_BRANCH_PREFIX}/fix-scroll-jump`, "wip"),
    ).toBe("wip/fix-scroll-jump");
  });

  it("produces a bare branch when the prefix is empty", () => {
    expect(buildGeneratedWorktreeBranchName("Fix scroll jump", "")).toBe("fix-scroll-jump");
  });

  it("falls back to a usable fragment when the suggestion is unusable", () => {
    expect(buildGeneratedWorktreeBranchName("!!!", "")).toBe("update");
  });
});

describe("applyGitStatusStreamEvent", () => {
  it("treats a remote-only update as a repository when local state is missing", () => {
    const remote: VcsStatusRemoteResult = {
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    };

    expect(applyGitStatusStreamEvent(null, { _tag: "remoteUpdated", remote })).toEqual({
      isRepo: true,
      hasPrimaryRemote: false,
      isDefaultRef: false,
      refName: null,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    });
  });

  it("preserves local-only fields when applying a remote update", () => {
    const current: VcsStatusResult = {
      isRepo: true,
      sourceControlProvider: {
        kind: "github",
        name: "GitHub",
        baseUrl: "https://github.com",
      },
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "feature/demo",
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [{ path: "src/demo.ts", insertions: 1, deletions: 0 }],
        insertions: 1,
        deletions: 0,
      },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };

    const remote: VcsStatusRemoteResult = {
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    };

    expect(applyGitStatusStreamEvent(current, { _tag: "remoteUpdated", remote })).toEqual({
      ...current,
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    });
  });
});
