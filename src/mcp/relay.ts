// stdio <-> unix-socket relay used when /usr/bin/nc is unavailable. Usage: node relay.ts <socket>
import { connect } from "node:net";

const path = process.argv[2];
if (!path) {
  process.stderr.write("usage: relay.ts <socket>\n");
  process.exit(2);
}
const sock = connect(path);
process.stdin.pipe(sock);
sock.pipe(process.stdout);
sock.on("close", () => process.exit(0));
sock.on("error", (err) => {
  process.stderr.write(`relay: ${err.message}\n`);
  process.exit(1);
});
process.stdin.on("end", () => sock.end());
