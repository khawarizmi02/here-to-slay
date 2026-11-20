import type { ReplayFile } from "./game.js";

/** Has the browser save `file`, as if the player had followed a download link. */
export function downloadFile(file: ReplayFile): void {
  const url = URL.createObjectURL(new Blob([file.contents], { type: file.mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = file.filename;
  link.click();
  // The download has started by the time the click returns; the URL is no longer needed after that.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
