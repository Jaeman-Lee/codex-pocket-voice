import { execFile } from "node:child_process";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function createTestCertificate(directory: string, host: string): Promise<{
  certificateFile: string;
  privateKeyFile: string;
}> {
  const certificateFile = join(directory, "certificate.pem");
  const privateKeyFile = join(directory, "private-key.pem");
  const subjectAltName = /^\d+(?:\.\d+){3}$/.test(host) ? `IP:${host}` : `DNS:${host}`;
  await execFileAsync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "2",
    "-subj", `/CN=${host}`,
    "-addext", `subjectAltName=${subjectAltName}`,
    "-keyout", privateKeyFile,
    "-out", certificateFile,
  ]);
  await chmod(privateKeyFile, 0o600);
  await chmod(certificateFile, 0o644);
  return { certificateFile, privateKeyFile };
}
