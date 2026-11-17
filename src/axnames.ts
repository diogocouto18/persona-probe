import type { CDPSession, Page } from "playwright";

/**
 * Playwright's AI snapshot leaves out an element's name when it can be derived
 * from its children, so a link wrapping a heading shows as a bare `link`. An
 * agent reads that as "no accessible name". These helpers ask Chromium for the
 * name assistive technology actually announces and write it into the snapshot,
 * marking elements that really have none.
 */

const INTERACTIVE_ROLES = [
  "link",
  "button",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "combobox",
  "textbox",
  "searchbox",
  "slider",
  "spinbutton",
];
const UNNAMED_LINE = new RegExp(
  `^(\\s*- (?:${INTERACTIVE_ROLES.join("|")})) (\\[ref=([a-z0-9]+)\\])(.*)$`,
);
const MAX_NAME = 120;
/** Upper bound on per-element lookups for one snapshot. */
export const MAX_NAME_LOOKUPS = 150;
const MARK = "data-persona-probe-ax";

/** Refs of interactive nodes the snapshot shows without a name. */
export function unnamedInteractiveRefs(aria: string): string[] {
  const refs: string[] = [];
  for (const line of aria.split("\n")) {
    const ref = UNNAMED_LINE.exec(line)?.[3];
    if (ref) refs.push(ref);
  }
  return refs;
}

function quote(name: string): string {
  const short = name.length > MAX_NAME ? `${name.slice(0, MAX_NAME - 1)}…` : name;
  return `"${short.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Writes resolved names into unnamed interactive lines: a non-empty name is
 * inserted the way Playwright shows names; an empty one becomes an explicit
 * `[no accessible name]` marker. Refs missing from `names` are left unchanged.
 */
export function annotateUnnamed(aria: string, names: Map<string, string>): string {
  return aria
    .split("\n")
    .map((line) => {
      const match = UNNAMED_LINE.exec(line);
      if (!match) return line;
      const [, head, refToken, ref, rest] = match;
      const name = names.get(ref as string);
      if (name === undefined) return line;
      return name
        ? `${head} ${quote(name)} ${refToken}${rest}`
        : `${head} ${refToken} [no accessible name]${rest}`;
    })
    .join("\n");
}

interface DescribedNode {
  backendNodeId: number;
  attributes?: string[];
}

/**
 * Resolves Chromium's computed accessible name for each ref (main document
 * only, capped at MAX_NAME_LOOKUPS). Elements are tagged with a temporary attribute
 * to map refs to DOM nodes, and the tags are removed afterwards.
 */
export async function resolveNames(
  page: Page,
  cdp: CDPSession,
  refs: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  // Refs look like e12 or f1e12 (the main frame gets a prefix after navigations).
  // Iframe elements are never found in the main document below, so they are skipped.
  const wanted = refs.filter((ref) => /^(f\d+)?e\d+$/.test(ref)).slice(0, MAX_NAME_LOOKUPS);
  if (wanted.length === 0) return names;
  try {
    for (const ref of wanted) {
      const handle = await page
        .getByRef(ref)
        .elementHandle({ timeout: 500 })
        .catch(() => null);
      await handle?.evaluate((el, r) => el.setAttribute("data-persona-probe-ax", r), ref);
      await handle?.dispose();
    }
    const { root } = (await cdp.send("DOM.getDocument", { depth: 0 })) as {
      root: { nodeId: number };
    };
    const { nodeIds } = (await cdp.send("DOM.querySelectorAll", {
      nodeId: root.nodeId,
      selector: `[${MARK}]`,
    })) as { nodeIds: number[] };
    for (const nodeId of nodeIds) {
      const { node } = (await cdp.send("DOM.describeNode", { nodeId })) as {
        node: DescribedNode;
      };
      const attrs = node.attributes ?? [];
      const ref = attrs[attrs.indexOf(MARK) + 1];
      if (!ref) continue;
      const ax = (await cdp.send("Accessibility.getPartialAXTree", {
        backendNodeId: node.backendNodeId,
        fetchRelatives: false,
      })) as { nodes: Array<{ name?: { value?: unknown } }> };
      const value = ax.nodes[0]?.name?.value;
      names.set(ref, typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
    }
  } catch {
    // Names are best effort: on any CDP failure the snapshot stays as Playwright made it.
  } finally {
    await page
      .evaluate(
        (mark) => document.querySelectorAll(`[${mark}]`).forEach((el) => el.removeAttribute(mark)),
        MARK,
      )
      .catch(() => {});
  }
  return names;
}
