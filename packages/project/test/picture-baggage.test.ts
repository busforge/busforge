import { test, expect, describe } from "bun:test";
import { extractPictureBaggage } from "../src/index.ts";
import { storeZip } from "./ziputil.ts";

// A program whose two TypePicture parameters name a baggage at the manufacturer root and one under a
// TargetPath (as OpenKNX lays out its images), plus a context-help zip no picture names.
const program = `<KNX><ManufacturerData><Manufacturer RefId="M-00FA"><ApplicationPrograms><ApplicationProgram Id="M-00FA_A-0001-01-0000"><Static><ParameterTypes>
  <ParameterType Id="M-00FA_A-0001-01-0000_PT-A"><TypePicture RefId="M-00FA_BG--logo.2Epng" /></ParameterType>
  <ParameterType Id="M-00FA_A-0001-01-0000_PT-B"><TypePicture RefId="M-00FA_BG-A0.5C12-ets.2Epng" HorizontalAlignment="Right" /></ParameterType>
  <ParameterType Id="M-00FA_A-0001-01-0000_PT-C"><TypePicture RefId="M-00FA_BG--missing.2Epng" /></ParameterType>
</ParameterTypes></Static></ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
const baggages = `﻿<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/23"><ManufacturerData><Manufacturer RefId="M-00FA"><Baggages>
  <Baggage TargetPath="" Name="logo.png" Id="M-00FA_BG--logo.2Epng"><FileInfo TimeInfo="2020-01-01T00:00:00Z" /></Baggage>
  <Baggage TargetPath="A0\\12" Name="ets.png" Id="M-00FA_BG-A0.5C12-ets.2Epng"><FileInfo TimeInfo="2020-01-01T00:00:00Z" /></Baggage>
  <Baggage TargetPath="" Name="missing.png" Id="M-00FA_BG--missing.2Epng"><FileInfo TimeInfo="2020-01-01T00:00:00Z" /></Baggage>
  <Baggage TargetPath="" Name="Help.zip" Id="M-00FA_BG--Help.2Ezip"><FileInfo TimeInfo="2020-01-01T00:00:00Z" /></Baggage>
</Baggages></Manufacturer></ManufacturerData></KNX>`;
const logo = Buffer.from("logo-bytes"), ets = Buffer.from("ets-bytes");

describe("extractPictureBaggage", () => {
  test("reads the images a program's TypePicture parameters name, root and TargetPath alike, and nothing else", () => {
    const zip = storeZip({
      "M-00FA/M-00FA_A-0001-01-0000.xml": program,
      "M-00FA/Baggages.xml": baggages,
      "M-00FA/Baggages/logo.png": logo,
      "M-00FA/Baggages/A0/12/ets.png": ets,
      "M-00FA/Baggages/Help.zip": Buffer.from("help"),
    });
    const out = extractPictureBaggage(zip, new Map([["M-00FA_A-0001-01-0000", program]]));
    const files = out.get("M-00FA_A-0001-01-0000")!;
    expect([...files.keys()].sort()).toEqual(["M-00FA_BG--logo.2Epng", "M-00FA_BG-A0.5C12-ets.2Epng"]);
    expect(files.get("M-00FA_BG--logo.2Epng")).toEqual({ name: "logo.png", data: logo });
    expect(files.get("M-00FA_BG-A0.5C12-ets.2Epng")).toEqual({ name: "ets.png", data: ets });
  });

  test("an archive without Baggages.xml, and a plain manufacturer XML, yield no images", () => {
    const zip = storeZip({ "M-00FA/M-00FA_A-0001-01-0000.xml": program, "M-00FA/Baggages/logo.png": logo });
    expect(extractPictureBaggage(zip, new Map([["M-00FA_A-0001-01-0000", program]])).size).toBe(0);
    expect(extractPictureBaggage(Buffer.from(program), new Map([["M-00FA_A-0001-01-0000", program]])).size).toBe(0);
  });
});
