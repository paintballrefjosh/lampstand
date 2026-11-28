import { utils } from "ssh2";

/**
 * A throwaway host key for a fake SSH server. ssh2's ed25519 generator now and then writes a private key its own parser
 * refuses ("Malformed OpenSSH private key": about 3 in 1000 with ssh2 1.17.0), so a pair is only used once it parses.
 */
export function testHostKey(): { public: string; private: string } {
  for (let attempt = 0; attempt < 20; attempt++) {
    const pair = utils.generateKeyPairSync("ed25519");
    if (!(utils.parseKey(pair.private) instanceof Error) && !(utils.parseKey(pair.public) instanceof Error)) return pair;
  }
  throw new Error("ssh2 produced no usable ed25519 key in 20 attempts");
}
