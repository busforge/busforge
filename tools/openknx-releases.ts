// The OpenKNX release archives the open demo's product data comes from (tools/demo-project.ts): one
// application each, its product XML at data/<name>.xml inside (the producer's output, which ETS would
// sign into a .knxprod; Busforge reads it as it is). The hash pins the archive OpenKNX published
// under the tag. Data only, so tools/corpus.ts can name the archives without loading the tool.
export interface OpenKnxRelease { repo: string; tag: string; asset: string; sha256: string }
export const OPENKNX_RELEASES: OpenKnxRelease[] = [
  { repo: "OAM-SwitchActuator", tag: "0.3", asset: "SwitchActuator-Release-0.3.0.zip", sha256: "d9a888ec318493b48e5f000c5350b93000d51778272d4ab391db6cd0657bbb24" },
  { repo: "OAM-LogicModule", tag: "3.5.2-Release", asset: "LogicModule-Release-3.5.2.zip", sha256: "3d223e9f65368af71b27a90e29138510196c8f5a620ec15b17e8db46e4cec9cb" },
  { repo: "OAM-RaumController", tag: "v5.5.1", asset: "RaumController-Release-5.5.1.zip", sha256: "f1b9f979932c82223557ef778ac22f7ca99320634e827d894e24b8fd3ea54f44" },
  { repo: "OAM-PresenceModule", tag: "3.6.2-Release", asset: "PresenceModule-Big-3.6.2.zip", sha256: "72752ddec67968ef77a369fa6b0b58c3699a639ec032fa483ac58a83a23d6093" },
];
