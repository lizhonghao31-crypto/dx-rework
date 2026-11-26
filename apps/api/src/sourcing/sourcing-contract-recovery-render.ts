import { fork } from "node:child_process";
import type { ContractPdfSnapshot } from "./sourcing-contract-pdf.js";

export function renderRecoveryContract(snapshot: ContractPdfSnapshot, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  const source = import.meta.url.endsWith(".ts");
  const entry = new URL(source ? "./sourcing-contract-render-child.ts" : "./sourcing-contract-render-child.js", import.meta.url);
  const child = fork(entry, [], {
    execArgv: source ? ["--import", "tsx"] : [],
    env: {},
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "advanced",
  });
  return new Promise((resolve, reject) => {
    let pdf: Buffer | undefined;
    let failure: Error | undefined;
    const terminate = () => child.kill("SIGKILL");
    signal.addEventListener("abort", terminate, { once: true });
    child.once("error", error => { failure = error; });
    child.once("message", (message: { pdf?: Buffer }) => { pdf = message.pdf; });
    child.once("close", code => {
      signal.removeEventListener("abort", terminate);
      if (signal.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else if (code === 0 && pdf?.byteLength) resolve(pdf);
      else reject(new Error("合同PDF渲染失败"));
    });
    child.send(snapshot, error => {
      if (error) {
        failure = error;
        terminate();
      }
    });
  });
}
