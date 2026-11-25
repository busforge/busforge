import { expect } from "bun:test";
import { transferChunks } from "../packages/knx/src/device.ts";
import { captureText } from "./corpus.ts";
import { corpusDescribe, corpusTest } from "./corpus-test.ts";

// ETS 6 sizes every secured write by the shorter of the device's PID_MAX_APDULENGTH and the maximum APDU
// the interface announces, and logs the outcome for the download ("[co <ia> LoadApplicationProgram]
// NegotiateMaxApduLength -> 55, restricted by ByTargetDevice"). Where a write that long fails, it limits the
// device to 40 and repeats it ("Operation using very long frames failed; switching to shorter frames",
// "LimitApduLength=40"). Its logs also carry the plaintext of every secured request, so they show the
// sizes ETS wrote at. Busforge, which repeats no failed write, must end where ETS ends, within the 55
// octets shown answered: the same sizes for every pair the logs show written, shorter ones above 55.
const SHOWN_APDU = 55;
const LOGS = [
  "gvs-amma-ets6log-keytable-add.txt", "gvs-amma-ets6log-keytable-plain.txt", "gvs-amma-ets6log-keytable-remove.txt",
  "gvs-amma-ets6log-keytable-restore.txt", "gvs-amma-ets6log-keytable-swap.txt",
  "jung-400021se-ets6log-partial-colour-123456.txt", "jung-400021se-ets6log-partial-colour-a1b2c3.txt",
  "jung-400021se-ets6log-partial-colour-revert.txt", "jung-400021se-ets6log-partial-flag-read-off.txt",
  "jung-400021se-ets6log-partial-flag-read-on.txt", "jung-400021se-ets6log-q2-nochange.txt",
  "jung-400021se-ets6log-q2-param-link.txt", "jung-400021se-ets6log-q2-param.txt", "jung-400021se-ets6log-q2-revert.txt",
  "mdt-ip-secure-ets6log-fulldownload.txt", "mdt-router-ets6log-fulldownload.txt", "mdt-router-ets6log-partial-ga-link.txt",
  "mdt-router-ets6log-partial-ga-unlink.txt", "mdt-router-ets6log-partial-name-revert.txt", "mdt-router-ets6log-partial-name.txt",
];

// The secured write octets besides the data: A_MemoryExtended_Write's 5 and the extended property write's
// 9, each plus the 13 of the secure framing.
const MEMORY_OCTETS = 5 + 13, PROPERTY_OCTETS = 9 + 13;

function secureLog(file: string) {
  const text = captureText(file);
  const one = (re: RegExp, what: string) => {
    const found = new Set([...text.matchAll(re)].map((m) => Number(m[1])));
    if (found.size !== 1) throw new Error(`${file}: ${found.size} values for ${what}`);
    return [...found][0];
  };
  const sent = text.split(/\r?\n/).filter((l) => !l.includes("Sending") && / Send Sec_req -> /.test(l));
  const sizes = (re: RegExp) => sent.flatMap((l) => { const m = l.match(re); return m ? [Number(m[1])] : []; });
  const limits = [...text.matchAll(/LoadApplicationProgram\] LimitApduLength=(\d+)/g)].map((m) => Number(m[1])).filter((n) => n > 0);
  return {
    deviceMax: one(/LoadApplicationProgram\] PID_MAX_APDULENGTH=(\d+)/g, "the device's maximum APDU"),
    interfaceMax: one(/InterfaceFeatures: .*MaxApduLength=(\d+)/g, "the interface's maximum APDU"),
    negotiated: one(/LoadApplicationProgram\] NegotiateMaxApduLength -> (\d+)/g, "the download's negotiated APDU"),
    limited: limits.length ? Math.min(...limits) : null,
    memory: sizes(/InnerTelegram=MemoryExtended_Write_req -> \S+ \([^)]*\) Address=\$[0-9A-F]+ Count=(\d+)/),
    flags: sizes(/InnerTelegram=PropertyExtValue_WriteCon_req -> .* ObjectType=17 Instance=1 PID=61 NumberOfElements=(\d+)/),
  };
}

corpusDescribe("secured write sizes against ETS's own logs", () => {
  for (const file of LOGS) {
    corpusTest(file, () => {
      const log = secureLog(file);
      // The rule as ETS's log states it: the shorter of the two values it names.
      expect(Math.min(log.deviceMax, log.interfaceMax)).toBe(log.negotiated);
      // ETS writes at no more than the negotiated size.
      expect(Math.max(0, ...log.memory)).toBeLessThanOrEqual(log.negotiated - MEMORY_OCTETS);
      expect(Math.max(0, ...log.flags)).toBeLessThanOrEqual(log.negotiated - PROPERTY_OCTETS);
      // Busforge for the same pair; where ETS fell back, Busforge's size for an interface that announces
      // nothing, which is also what it reads from Busforge's bridge (its extended search answer has no
      // Extended Device Information DIB).
      const ends = Math.min(log.limited ?? log.negotiated, SHOWN_APDU);
      const c = transferChunks(log.deviceMax, true, log.limited === null ? log.interfaceMax : null);
      expect({ memory: c.extWrite, flags: c.propWrite }).toEqual({ memory: ends - MEMORY_OCTETS, flags: ends - PROPERTY_OCTETS });
    });
  }

  // The device and interface pairs at whose size ETS actually wrote, so a size is pinned by writes and not
  // only by ETS's log line.
  corpusTest("ETS wrote at the size on both bench devices behind 40 and on the MDT IP Router Secure behind 210", () => {
    const shown = new Set(LOGS.flatMap((file) => {
      const log = secureLog(file);
      const ends = log.limited ?? log.negotiated;
      const pair = `${log.deviceMax}/${log.limited ?? log.interfaceMax}`;
      return [
        ...(log.memory.includes(ends - MEMORY_OCTETS) ? [`memory ${pair} ${ends - MEMORY_OCTETS}`] : []),
        ...(log.flags.includes(ends - PROPERTY_OCTETS) ? [`PID 61 ${pair} ${ends - PROPERTY_OCTETS}`] : []),
      ];
    }));
    expect([...shown].sort()).toEqual([
      "PID 61 233/40 18", "PID 61 55/210 33", "PID 61 55/40 18",
      "memory 233/40 22", "memory 55/210 37", "memory 55/40 22",
    ]);
  });
});
