# Try Busforge without a bus

Two demo projects show Busforge without any KNX hardware: an invented flat or house, its rooms,
group addresses and devices, every device configured and linked. Nothing is written to a bus;
every device is placed, never programmed. `tools/demo-project.ts` builds either one through the
API of a running Busforge, so it works against the container from [install.md](install.md) as well
as against a development server.

| Demo | Devices | Product data |
|---|---|---|
| **OpenKNX-Musterwohnung** | 4 OpenKNX devices | OpenKNX's own release archives, which the tool downloads from GitHub |
| **Musterhaus Sonnenweg** | 17 devices of ten manufacturers | The manufacturers' product databases, which you bring |

Busforge itself never downloads or ships product data ([install.md](install.md#3-product-definitions)).
The open demo's download is the tool's, made when you run it, from OpenKNX's GitHub releases.

## What you need

- A running Busforge, empty or not. The tool refuses an instance that already holds a project of
  the demo's name.
- A checkout of this repository and [Bun](https://bun.sh) to run the tool:

```bash
git clone https://github.com/busforge/busforge.git && cd busforge
bun install
```

## The open demo

```bash
bun run tools/demo-project.ts http://127.0.0.1:3000
```

The project, *OpenKNX-Musterwohnung*, is a flat on one floor with five rooms (one of them a
distribution board), 13 group addresses in four main groups (central functions, lighting, room
climate, presence) and four devices of [OpenKNX](https://github.com/OpenKNX), whose applications
are open source:

| Address | Device | Application | What the demo sets up |
|---|---|---|---|
| 1.4.1 | Schaltaktor Licht | OpenKNX Schaltaktor (OAM-SwitchActuator 0.3) | Four channels switched on and named, each with its switching and status object linked; date and time received |
| 1.4.2 | Logikmodul | OpenKNX Logikmodul (OAM-LogicModule 3.5.2) | One AND channel: the hall's movement, and the night mode inverted, switch the hall light |
| 1.4.10 | Raumcontroller Wohnen | OpenKNX RaumController (OAM-RaumController 5.5.1) | Temperature and humidity sensor chosen, both values linked, date and time received |
| 1.4.11 | Präsenzmelder Flur | OpenKNX Präsenzmelder (OAM-PresenceModule 3.6.2) | One channel with the built-in motion sensor, its output linked, the light's status received |

The tool downloads one release archive per application from `github.com/OpenKNX`, about 32 MB in
all, and refuses an archive whose SHA-256 is not the one pinned in the tool. From each archive it
imports the product XML (`data/<name>.xml`, the OpenKNX producer's output) into the catalogue. The
archives stay OpenKNX's: GPL-3.0, as their repositories state; the repository here carries none of
them.

Without network access, download the four archives named in `OPENKNX_RELEASES` in
`tools/demo-project.ts` elsewhere, put them into one directory and name it:

```bash
bun run tools/demo-project.ts --openknx ./openknx-archives http://127.0.0.1:3000
```

The OpenKNX archives carry the picture the applications show on their first page, but the product
XML does not include it, so that parameter says the picture is not in the catalogue.

## The demo with manufacturer products

```bash
bun run tools/demo-project.ts --manufacturers products-a.knxprod products-b.knxprod http://127.0.0.1:3000
```

The project, *Musterhaus Sonnenweg*, is an invented single-family house: a building with three
floors and nine rooms (one of them a distribution board), 41 group addresses in five main groups
(central functions, lighting, blinds, heating, presence), and 17 devices of ten manufacturers,
products from the device table in [status.md](status.md#devices-driven-on-real-hardware): switching, blind and
heating actuators, a DALI gateway, push-button and universal interfaces, presence detectors, a
weather station, a power supply and an IP interface. Each device has an invented name and individual
address and sits in a room; where a channel is closed by default, the parameter that opens it is
set; its objects are linked, some of them to several addresses. The project ends with one snapshot.

Its product data is manufacturer catalogue data, the manufacturers' to distribute, so this
repository does not carry it. Get
each product database from the manufacturer's download page or the KNX Online Catalog, in the
application version below, and give the tool every file; one file may hold several products. Each
device names its application program by id (manufacturer, application number and version), so a
product database with another version of an application is refused, naming the product it lacks,
before any project is made.

| Manufacturer | Product | Order number | Application program |
|---|---|---|---|
| ABB | US/U4.2 Universal Interface,4-fold,FM | GH Q631 0070 R0111 | `M-0002_A-A001-13-63C2` |
| Albrecht Jung | Push-button interface, 2-gang | 400021SE | `M-0004_A-7072-21-99A7-O000A` |
| Basalte | Auro KNX | 180-02 | `M-0081_A-FE01-11-75D9` |
| Gira Giersiepen | Tastsensor 3 Komfort 3fach | 5133 00 | `M-0008_A-10D7-11-2783-O000A` |
| GVS | Multifunctional Actuator with Secure, 4-Fold | AMMA-04/06.S | `M-0085_A-0072-30-69AA` |
| MDT technologies | SCN-IP000.03 IP Interface with Secure | SCN-IP000.03 | `M-0083_A-0137-20-7EB2` |
| MDT technologies | BE-06001.02 Universal Interface 6-fold | BE-06001.02 | `M-0083_A-00B4-32-3919` |
| MDT technologies | BE-02001.02 Universal Interface 2-fold | BE-02001.02 | `M-0083_A-00B6-32-9642` |
| MEAN WELL | KNX-40E-1280D Power Supply | KNX-40E-1280D | `M-0162_A-0004-11-F245` |
| OpenKNX | RaumController | OpenKnxRaumController | `M-00FA_A-A012-55-E5F5` |
| Steinel | True Presence | 4007841056339 | `M-008E_A-7079-10-9C41` |
| Theben | RMG 8 T, JMG 4 T, HMG 6 T (MIX 2) | 4930200, 4930250, 4930240 | `M-0048_A-493B-21-B471` |
| Theben | DALI-Gateway KNX plus | 9070929 | `M-0048_A-9071-20-F258-O00EF` |
| Theben | TheLuxa P300 KNX | 1019610 | `M-0048_A-107E-12-5B58` |
| Theben | Meteodata 140 S 24V | 1409201 | `M-0048_A-140C-14-EB70` |

The OpenKNX RaumController here is release 5.5.1 as ETS holds it after the OpenKNX producer's
`knxprod` step: its id ends in a hash ETS computes. The release's own product XML, which the open
demo uses, names it with `0000` in that place, a different id. That the `knxprod` step on another
machine gives the same hash has not been checked.

## When a build stops

The tool refuses a product the databases lack, and any parameter, link, address or room that does
not read back as written. A run that stops after creating the project names it as half-built;
delete the project before the next run (the imported products stay in the catalogue, which is
harmless).
