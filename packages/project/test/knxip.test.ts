import { test, expect } from "bun:test";
import { parseProject } from "../src/parse.ts";

// The KNXnet/IP settings of a DeviceInstance, as ETS 6 stores them in 0.xml (the shape of the MDT IP Interface
// Secure's instance, values made up), and an empty child element of the Installation, which the parsed node
// holds as "" like an empty attribute.
const XML = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/23"><Project Id="P-0001"><Installations>
<Installation Name="" BCUKey="4294967295" IPRoutingLatencyTolerance="2000"><Trades/><Topology>
<Area Id="P-0001-0_A-1" Address="1"><Line Id="P-0001-0_L-1" Address="1"><Segment Id="P-0001-0_S-1" Number="0" MediumTypeRefId="MT-0">
<DeviceInstance Id="P-0001-0_DI-3" Address="3" Name="" ProductRefId="M-0083_H-1_P-1" Hardware2ProgramRefId="M-0083_H-1_HP-1">
<AdditionalAddresses><Address Address="250" Name="" /></AdditionalAddresses>
</DeviceInstance>
<DeviceInstance Id="P-0001-0_DI-0" Address="2" Name="Taster 0" ProductRefId="M-0083_H-2_P-2" Hardware2ProgramRefId="M-0083_H-2_HP-2" />
<DeviceInstance Id="P-0001-0_DI-1" Address="7" Name="" ProductRefId="M-0083_H-1_P-1" Hardware2ProgramRefId="M-0083_H-1_HP-1">
<AdditionalAddresses><Address Address="255" Name="" /><Address Address="" Name="" /></AdditionalAddresses>
<IPConfig Assign="Fixed" IPAddress="192.0.2.2" SubnetMask="255.255.255.0" DefaultGateway="192.0.2.1" />
<Security ToolKey="a" LoadedToolKey="a" SequenceNumber="1" />
</DeviceInstance>
<DeviceInstance Id="P-0001-0_DI-2" Address="1" Name="Taster" ProductRefId="M-0083_H-2_P-2" Hardware2ProgramRefId="M-0083_H-2_HP-2" />
</Segment></Line></Area></Topology></Installation></Installations></Project></KNX>`;

// A self-closing device before another, and a device with additional addresses but no IPConfig or Security,
// take nothing from the device after them.
test("a KNXnet/IP device's settings: attributes off their own tags, an unparseable address as null, only devices that have them", () => {
  const p = parseProject(XML, undefined, "x", new Map([["M-0083_H-1_P-1", "IP Interface"]]), new Map(), new Map([["M-0083_H-1_P-1", ["IP-Schnittstelle"]]]));
  expect(p.deviceKnxIp).toEqual([{
    deviceId: "P-0001-0_DI-3", instanceName: "", productName: "IP Interface", productNameTranslations: ["IP-Schnittstelle"], ipConfig: null,
    additionalAddresses: [250], securityAttributes: [], toolKeyLoaded: false, busInterfaces: 0,
    installation: { Name: "", BCUKey: "4294967295", IPRoutingLatencyTolerance: "2000" },
  }, {
    deviceId: "P-0001-0_DI-1", instanceName: "", productName: "IP Interface", productNameTranslations: ["IP-Schnittstelle"],
    ipConfig: { Assign: "Fixed", IPAddress: "192.0.2.2", SubnetMask: "255.255.255.0", DefaultGateway: "192.0.2.1" },
    additionalAddresses: [255, null], securityAttributes: ["ToolKey", "LoadedToolKey", "SequenceNumber"], toolKeyLoaded: true, busInterfaces: 0,
    installation: { Name: "", BCUKey: "4294967295", IPRoutingLatencyTolerance: "2000" },
  }]);
});

test("the default BCU key is no secret the import leaves out", () => {
  expect(parseProject(XML, undefined, "x").secretsNotImported).toBe(0);
});

// Synthetic secrets in the shape of an ETS 6 IP Secure project (backbone key on the installation, a device's
// authentication code and management password, tunnelling user passwords on its bus interfaces).
test("KNX IP Secure keys and passwords and a BCU key other than the default are counted as not imported and kept out of the device settings", () => {
  const backbone = "c3ludGhldGljLWJhY2tib25l";
  const secured = XML
    .replace('<Installation Name="" BCUKey="4294967295"', `<Installation Name="" BCUKey="305419896" IPRoutingBackboneKey="${backbone}"`)
    .replace('<Security ToolKey="a" LoadedToolKey="a" SequenceNumber="1" />',
      '<Security ToolKey="a" LoadedToolKey="a" SequenceNumber="1" DeviceAuthenticationCode="synthauth" DeviceManagementPassword="synthmgmt" LoadedIPRoutingBackboneKey="c3ludGhldGljLWJhY2tib25l" />'
      + '<BusInterfaces><BusInterface RefId="M-0083_A-1_BI-1" Password="synthuser1" /><BusInterface RefId="M-0083_A-1_BI-2" Password="" /></BusInterfaces>');
  const p = parseProject(secured, undefined, "x");
  // backbone key + BCU key + authentication code + management password + one tunnelling password
  expect(p.secretsNotImported).toBe(5);
  const settings = p.deviceKnxIp.find((d) => d.deviceId === "P-0001-0_DI-1")!;
  expect(settings.installation).toEqual({ Name: "", BCUKey: "", IPRoutingBackboneKey: "", IPRoutingLatencyTolerance: "2000" });
  const all = JSON.stringify(p);
  for (const secret of [backbone, "305419896", "synthauth", "synthmgmt", "synthuser1"]) expect(all).not.toContain(secret);
});

test("the keys and passwords the import leaves out with a device outside the topology or a further installation are counted too", () => {
  const secured = XML
    .replace("</Topology></Installation>", '<UnassignedDevices><DeviceInstance Id="P-0001-0_DI-9" Name="" ProductRefId="M-0083_H-1_P-1"><BusInterfaces><BusInterface RefId="M-0083_A-1_BI-1" Password="synthuser9" /></BusInterfaces></DeviceInstance></UnassignedDevices></Topology></Installation>')
    .replace("</Installation></Installations>", '</Installation><Installation Name="Second" BCUKey="305419896"><Topology><Area Id="P-0001-1_A-1" Address="1"><Line Id="P-0001-1_L-1" Address="1"><DeviceInstance Id="P-0001-1_DI-1" Address="5"><Security ToolKey="a" DeviceManagementPassword="synthmgmt2" /></DeviceInstance></Line></Area></Topology></Installation></Installations>');
  const p = parseProject(secured, undefined, "x");
  expect(p.unassignedDevices).toBe(1);
  expect(p.skippedInstallations).toBe(1);
  // the unassigned device's tunnelling password, the second installation's BCU key and its device's management password
  expect(p.secretsNotImported).toBe(3);
});
