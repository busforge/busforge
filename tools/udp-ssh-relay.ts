// UDP-over-SSH relay for reaching a remote KNXnet/IP bridge from a machine whose local
// route to it is broken (here: a Mac dual-homed on the same subnet as the bridge, so its
// UDP source-address selection fails with EHOSTUNREACH). SSH forwards TCP, not UDP, so we
// carry each KNXnet/IP datagram as a 2-byte-length-prefixed frame over a TCP stream:
//
//   busforge (Mac) --UDP--> [local relay] --TCP--> ssh -L --TCP--> [remote relay] --UDP--> bridge:3671
//
// This works ONLY because busforge's KnxIpTunnel uses a SINGLE socket with a NAT-mode HPAI
// (0.0.0.0:0): the gateway replies to the observed packet source, which is the remote relay's
// UDP socket, so no separate data endpoint has to be tunnelled back.
//
//   remote (on the bridge host):  bun tools/udp-ssh-relay.ts remote <tcpPort> <bridgeUdpPort>
//   ssh -N -L <tcpPort>:127.0.0.1:<tcpPort> user@bridgehost
//   local  (on the dev machine):  bun tools/udp-ssh-relay.ts local  <udpPort> <tcpPort>
//   then point busforge's connection at 127.0.0.1:<udpPort>.
import net from "node:net";
import dgram from "node:dgram";

const mode = process.argv[2];

// A TCP stream carries datagrams as [uint16 length][payload]. Decode incrementally.
function framer(onFrame: (b: Buffer) => void) {
  let buf = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const len = buf.readUInt16BE(0);
      if (buf.length < 2 + len) break;
      onFrame(buf.subarray(2, 2 + len));
      buf = buf.subarray(2 + len);
    }
  };
}
const frame = (b: Buffer) => { const h = Buffer.alloc(2); h.writeUInt16BE(b.length, 0); return Buffer.concat([h, b]); };

if (mode === "remote") {
  const tcpPort = Number(process.argv[3] || 7371);
  const bridgePort = Number(process.argv[4] || 3671);
  net.createServer((sock) => {
    // One bridge-facing UDP socket per TCP connection, so channels never cross.
    const udp = dgram.createSocket("udp4");
    udp.on("message", (msg) => sock.write(frame(msg)));
    udp.on("error", () => sock.destroy());
    sock.on("data", framer((f) => udp.send(f, bridgePort, "127.0.0.1")));
    const done = () => { try { udp.close(); } catch { /* already closed */ } };
    sock.on("close", done); sock.on("error", done);
    console.error(`[remote] client connected; bridging to 127.0.0.1:${bridgePort}`);
  }).listen(tcpPort, "127.0.0.1", () => console.error(`[remote] TCP listen 127.0.0.1:${tcpPort} -> UDP bridge :${bridgePort}`));
}

else if (mode === "local") {
  const udpPort = Number(process.argv[3] || 3671);
  const tcpPort = Number(process.argv[4] || 7371);
  const udp = dgram.createSocket("udp4");
  // busforge is the only client; remember where its datagrams came from so replies go back there.
  let client: { port: number; address: string } | null = null;
  const tcp = net.connect(tcpPort, "127.0.0.1", () => console.error(`[local] TCP -> 127.0.0.1:${tcpPort} up`));
  tcp.on("data", framer((f) => { if (client) udp.send(f, client.port, client.address); }));
  tcp.on("error", (e) => { console.error(`[local] TCP error: ${e.message}`); process.exit(1); });
  tcp.on("close", () => { console.error("[local] TCP closed"); process.exit(1); });
  udp.on("message", (msg, rinfo) => { client = { port: rinfo.port, address: rinfo.address }; tcp.write(frame(msg)); });
  udp.bind(udpPort, "127.0.0.1", () => console.error(`[local] UDP listen 127.0.0.1:${udpPort} -> TCP :${tcpPort}`));
}

else {
  console.error("usage: udp-ssh-relay.ts remote <tcpPort> <bridgeUdpPort> | local <udpPort> <tcpPort>");
  process.exit(2);
}
