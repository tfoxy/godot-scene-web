// A throwaway test PKI for the wss legs: a test CA and
// a leaf it signs (SAN localhost, 127.0.0.1, ::1 and any extra IPs), a key that is not the leaf's,
// all ECDSA P-256, generated with the `openssl` CLI into a fresh temporary directory at test time.
// Nothing here is ever committed; the caller removes the directory.
import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TestPki {
  dir: string;
  ca: string; // CA certificate (PEM path), the trust anchor a client is given
  cert: string; // leaf certificate (PEM path)
  key: string; // leaf key (PEM path)
  otherKey: string; // a P-256 key that is not the leaf's (the tls-config-invalid row)
  /** SHA-256 of the leaf's DER, 64 lowercase hex (live-carriers.json cert_sha256). */
  leafSha256: string;
  /** base64 SHA-256 of the leaf's SubjectPublicKeyInfo (Chromium --ignore-certificate-errors-spki-list). */
  spkiSha256Base64: string;
}

function openssl(args: string[], cwd: string): void {
  const r = spawnSync("openssl", args, { cwd, encoding: "utf8" });
  if (r.status !== 0)
    throw new Error(`openssl ${args.join(" ")}: ${r.error ?? r.stderr}`);
}

export function makeTestPki(extraIps: string[] = []): TestPki {
  const dir = mkdtempSync(join(tmpdir(), "rs-wss-pki-"));
  const ec = [
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
  ];
  openssl(
    [
      "req",
      "-x509",
      ...ec,
      "-keyout",
      "ca.key",
      "-out",
      "ca.pem",
      "-days",
      "2",
      "-subj",
      "/CN=render-stream test CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign",
    ],
    dir,
  );
  openssl(
    [
      "req",
      ...ec,
      "-keyout",
      "key.pem",
      "-out",
      "leaf.csr",
      "-subj",
      "/CN=localhost",
    ],
    dir,
  );
  const sans = [
    "DNS:localhost",
    "IP:127.0.0.1",
    "IP:::1",
    ...extraIps.map((ip) => `IP:${ip}`),
  ].join(",");
  writeFileSync(
    join(dir, "leaf.ext"),
    `subjectAltName=${sans}\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n`,
  );
  openssl(
    [
      "x509",
      "-req",
      "-in",
      "leaf.csr",
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-out",
      "cert.pem",
      "-days",
      "2",
      "-extfile",
      "leaf.ext",
    ],
    dir,
  );
  openssl(
    [
      "genpkey",
      "-algorithm",
      "EC",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-out",
      "other-key.pem",
    ],
    dir,
  );
  const leaf = new X509Certificate(readFileSync(join(dir, "cert.pem")));
  const spki = leaf.publicKey.export({ type: "spki", format: "der" });
  return {
    dir,
    ca: join(dir, "ca.pem"),
    cert: join(dir, "cert.pem"),
    key: join(dir, "key.pem"),
    otherKey: join(dir, "other-key.pem"),
    leafSha256: createHash("sha256").update(leaf.raw).digest("hex"),
    spkiSha256Base64: createHash("sha256").update(spki).digest("base64"),
  };
}
