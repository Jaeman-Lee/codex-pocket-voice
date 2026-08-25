import qrcode from "qrcode-terminal";

export function renderPocketLinkTerminalQr(value: string): string {
  let rendered = "";
  qrcode.setErrorLevel("M");
  qrcode.generate(value, { small: true }, (output) => { rendered = output; });
  if (!rendered) throw new Error("PocketLink QR renderer returned no output");
  return [...rendered].map((character) => {
    if (character === " ") return "\u001b[40m \u001b[0m";
    if (character === "█") return "\u001b[47m \u001b[0m";
    if (character === "▀" || character === "▄") return `\u001b[37;40m${character}\u001b[0m`;
    return character;
  }).join("");
}
