/**
 * Provider answer extraction: the browser serializes the newest assistant message
 * into a JSON tree; this module converts the tree to markdown. Pure and fixture-testable.
 */

export interface DomTreeNode {
  tag: string;
  text?: string;
  href?: string;
  language?: string;
  children?: DomTreeNode[];
}

const SKIPPED_TAGS = new Set(["style", "script", "button", "svg", "noscript"]);

function escapeCodeFence(language: string | undefined, code: string): string {
  const fence = /```/.test(code) ? "````" : "```";
  return `${fence}${language ?? ""}\n${code.replace(/\n$/, "")}\n${fence}`;
}

function inlineText(node: DomTreeNode): string {
  switch (node.tag) {
    case "#text": return node.text ?? "";
    case "strong": case "b": return `**${inlineChildren(node)}**`;
    case "em": case "i": return `*${inlineChildren(node)}*`;
    case "code": return `\`${node.text ?? inlineChildren(node)}\``;
    case "a": return node.href ? `[${inlineChildren(node)}](${node.href})` : inlineChildren(node);
    case "br": return "\n";
    default: return inlineChildren(node);
  }
}

function inlineChildren(node: DomTreeNode): string {
  return (node.children ?? []).map(inlineText).join("");
}

function blockLines(node: DomTreeNode): string[] {
  const children = node.children ?? [];
  switch (node.tag) {
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
      const level = Number(node.tag[1]);
      return [`${"#".repeat(level)} ${inlineChildren(node).trim()}`];
    }
    case "p": case "blockquote-inner": {
      const text = inlineChildren(node).trim();
      return text ? [text, ""] : [];
    }
    case "blockquote":
      return children.flatMap(blockLines).map(line => line ? `> ${line}` : ">");
    case "ul": case "ol": {
      const lines: string[] = [];
      let index = 1;
      for (const child of children) {
        if (child.tag !== "li") continue;
        const marker = node.tag === "ol" ? `${index}. ` : "- ";
        // Inline runs before the first block child form the item text; nested blocks indent.
        const nested = child.children ?? [];
        const firstBlockAt = nested.findIndex(item => item.tag !== "#text" && !["strong", "em", "code", "a", "b", "i", "span", "br"].includes(item.tag));
        const inlinePart = inlineChildren({ tag: "span", children: firstBlockAt === -1 ? nested : nested.slice(0, firstBlockAt) }).trim();
        lines.push(`${marker}${inlinePart}`.trimEnd());
        const blockPart = firstBlockAt === -1 ? [] : nested.slice(firstBlockAt).flatMap(blockLines);
        for (const nestedLine of blockPart) lines.push(nestedLine ? `  ${nestedLine}` : "");
        index += 1;
      }
      if (lines.length) lines.push("");
      return lines;
    }
    case "pre": {
      const codeNode = children.find(child => child.tag === "code") ?? children[0];
      const code = codeNode ? inlineChildren(codeNode) : inlineChildren(node);
      return [escapeCodeFence(codeNode?.language ?? node.language, code), ""];
    }
    case "table": {
      const rows = children.filter(child => child.tag === "thead" || child.tag === "tbody" || child.tag === "tr");
      const tableRows = rows.flatMap(section => section.tag === "tr" ? [section] : (section.children ?? []).filter(row => row.tag === "tr"));
      const lines: string[] = [];
      tableRows.forEach((row, rowIndex) => {
        const cells = (row.children ?? []).filter(cell => cell.tag === "td" || cell.tag === "th").map(cell => inlineChildren(cell).replace(/\|/g, "\\|").trim());
        if (!cells.length) return;
        lines.push(`| ${cells.join(" | ")} |`);
        if (rowIndex === 0) lines.push(`| ${cells.map(() => "---").join(" | ")} |`);
      });
      if (lines.length) lines.push("");
      return lines;
    }
    case "hr": return ["---", ""];
    default: {
      // Unknown containers: descend; leaf blocks become inline paragraphs.
      if (!children.length) {
        const text = (node.text ?? "").trim();
        return text ? [text, ""] : [];
      }
      if (children.every(child => child.tag === "#text" || ["strong", "em", "code", "a", "b", "i", "span", "br"].includes(child.tag))) {
        const text = inlineChildren(node).trim();
        return text ? [text, ""] : [];
      }
      return children.flatMap(blockLines);
    }
  }
}

/** Convert a serialized assistant-message DOM tree to bounded markdown. */
export function treeToMarkdown(root: DomTreeNode, maxChars = 64_000): string {
  const markdown = blockLines(root).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (markdown.length <= maxChars) return markdown;
  return `${markdown.slice(0, maxChars)}\n\n[truncated: response exceeded ${maxChars} characters]`;
}
