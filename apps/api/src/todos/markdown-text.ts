/** Render business text literally inside DingTalk Markdown; URLs/buttons stay server-owned. */
export const escapeDingTalkMarkdownText = (text: string): string => text
  .replace(/\r\n?/g, "\n")
  .split("").filter(character => character === "\n" || character === "\t" || (character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)).join("")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replace(/[\\`*_{}[\]()#+.!|~:=/-]/g, "\\$&");
