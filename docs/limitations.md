# Limitations and known issues

Busforge is an **alpha**. It is meant for technically capable users who run their own KNX
installation, keep their ETS project as a backup and can recover a device by other means if a
write goes wrong. This page lists what Busforge does not do, what it does without proof on your
device, and the faults that are known and not fixed. It promises no date for any of them.

How far each capability is proven, product by product, is in [status.md](status.md) and the
generated [compatibility.md](compatibility.md).

## What Busforge does not do

| | |
|---|---|
| **KNX IP Secure** | Not supported. Busforge talks to an interface over a plain KNXnet/IP tunnel only; an interface that accepts nothing but secure tunnelling cannot be used. See [KNX Secure](#knx-secure-data-secure-yes-ip-secure-no) below. |
| **Application code / firmware download** | Not implemented (no LSM 5). A System 7 full download writes the static code segments the product data carries; there is no separate code load. |
| **Property-based loading** | Not implemented: interface-object devices with no memory image are refused. |
| **System 2 and System 300 devices** | Recognised by their mask and refused. |
| **System 1 devices** | Read only, with one exception: the download of a Data Secure KNXnet/IP interface on mask MV-0012. Every other System 1 write is refused. |
| **Powerline, RF and IP media** | Share the code of the twisted-pair masks, but have never run on the wire. All hardware verification is on twisted pair. |
| **Vendor plugins (DCA)** | One read-only replacement view, for one DALI gateway. Nothing is written back. |
| **Authentication** | Busforge has no login. Anyone who reaches its port can program devices. Keep it on a trusted network, or put authentication in front of it ([deployment.md](deployment.md#behind-a-reverse-proxy)). |

A device family, mask or segment type Busforge does not handle is refused with a coded error that
the app explains. It is never routed into a path that produces plausible-looking bytes.

## Devices nobody has tested

Most KNX products have never been in front of Busforge. A product without its own evidence in
[compatibility.md](compatibility.md) can still be programmed where its memory model is supported,
but only after you have acknowledged, once per project, that it is untested; the server refuses
the write until then. Evidence from a sibling product (same manufacturer, same mask, another order
number) is never counted for yours.

Where Busforge cannot evaluate something the product definition requires, the write is refused
and the app offers a read-only diagnostic package instead
([raw-acquisition.md](raw-acquisition.md#diagnostic-package)).

A passing test suite proves that Busforge's own output is stable and that its encoders are
correct. It proves nothing about your device ([status.md](status.md#what-green-tests-prove-and-what-they-do-not)).

## KNX Secure: Data Secure yes, IP Secure no

KNX Secure is two separate mechanisms, and Busforge implements one of them.

| | KNX Data Secure | KNX IP Secure |
|---|---|---|
| Protects | each management and group telegram to and from a device | the connection between a tool and its KNXnet/IP interface |
| Busforge | reads and programs Data Secure devices, activates a factory device from its certificate, sends and decodes secured group telegrams | **not supported** |
| Shown on | two products, plus the download of one Data Secure KNXnet/IP interface ([status.md](status.md#capabilities)) | |

Busforge drives a secure device only under a tool key it holds: imported from your ETS project,
entered by hand, or written by Busforge when it activates the device. Details in
[knx-secure.md](knx-secure.md).

## Known issues

**A programming run over a UDP connection to the Busforge bridge can stop with "the tunnel is closed".**
Over UDP the bridge closes a tunnel whose client does not acknowledge its messages within two seconds.
Busforge prepares the device's data while the tunnel is open; on a slow host (a small NAS, a container
with a low CPU limit) and with a very large application program that preparation can take longer than
that, and the write then ends with `TUNNEL_CLOSED`, usually before anything was written; where a write
was already under way, Busforge reports it as interrupted and offers the full download. Workaround: set
the connection's transport to TCP (or `auto`, which tries TCP first); over TCP the bridge needs no
acknowledgements and the pause costs nothing.

**A secured full download of a Jung 400021SE can stop with "the device closed the connection".** Rarely,
the device ends the management connection in the middle of a Data Secure full download, and Busforge
stops with `DEVICE_CLOSED_CONNECTION`. The cause is not known, and repeated runs do not reproduce
it. Workaround: start the full download again. A full download writes the device's whole
configuration, so a repeated run leaves it as a single successful one does.

**An interrupted write does not repair the device by itself.** A write cut off inside its load
bracket (power loss, a lost connection, a container killed mid-write) ends as
`FLASH_INTERRUPTED_UNLOADED`, and the device may stay unloaded. The flash dialog then offers the full
download, which rewrites the whole configuration. A container stop waits for a running write
([deployment.md](deployment.md#stopping-and-updating)); a `SIGKILL` or a host reboot does not.

## Shown on few devices

**Long memory writes have not run on a device.** Busforge writes up to the shorter of the device's
and the interface's maximum frame length, as ETS does. Writes longer than 12 bytes (classic) or 32
bytes (extended) have run on no device yet.

**One KNX USB interface model.** The USB transport is proven on one interface model. Its limits
(chunk sizes, management only on the interface's own address) are properties of that controller and
may differ on yours.

The full list of what is implemented but not shown on hardware is
[status.md, Known unproven](status.md#known-unproven).

## Reporting a problem

Open an issue on [GitHub](https://github.com/busforge/busforge/issues): a problem, a device that does
not work, or one that does. [reporting.md](reporting.md) describes the prefilled report from the app,
what stays out of a public issue, and how to share a diagnostic package.
