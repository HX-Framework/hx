"""Checks the release binaries for what the machines that run hx can load.

  linux    the newest glibc symbol version a binary needs is at most 2.17,
           as for hx's own builds (the Bun runtime needs 2.17);
  windows  the program imports no Visual C++ runtime DLL (vcruntime*,
           msvcp*), which a clean Windows does not have; `-svc` builds are
           windowless (GUI subsystem) and the others console programs.

Reads the files as data only. Prints what it found for each file.

Usage: python3 check-binaries.py <dir with the uncompressed binaries>
"""

import os
import re
import struct
import sys

GLIBC_FLOOR = (2, 17)
CONSOLE, GUI = 3, 2


def elf_glibc_versions(data):
    """Every GLIBC_x.y version the ELF's version-needs section names."""
    if data[:4] != b"\x7fELF" or data[4] != 2:
        raise ValueError("not a 64-bit ELF file")
    end = "<" if data[5] == 1 else ">"
    shoff, = struct.unpack_from(end + "Q", data, 0x28)
    shentsize, shnum = struct.unpack_from(end + "HH", data, 0x3A)
    sections = []
    for i in range(shnum):
        name, typ, flags, addr, offset, size, link, info, align, entsize = struct.unpack_from(
            end + "IIQQQQIIQQ", data, shoff + i * shentsize
        )
        sections.append((typ, offset, link, info))

    def cstr(sec_offset, off):
        start = sec_offset + off
        return data[start:data.index(b"\0", start)].decode()

    versions = set()
    for typ, offset, link, info in sections:
        if typ != 0x6FFFFFFE:  # SHT_GNU_verneed
            continue
        strtab = sections[link][1]
        off = offset
        for _ in range(info):
            _, cnt, _, aux, nxt = struct.unpack_from(end + "HHIII", data, off)
            aoff = off + aux
            for _ in range(cnt):
                _, _, _, vname, anext = struct.unpack_from(end + "IHHII", data, aoff)
                versions.add(cstr(strtab, vname))
                aoff += anext
            off += nxt
    return versions


def pe_subsystem_and_imports(data):
    """The PE optional header's subsystem and the names of imported DLLs."""
    if data[:2] != b"MZ":
        raise ValueError("not a PE image")
    pe, = struct.unpack_from("<I", data, 0x3C)
    if data[pe:pe + 4] != b"PE\0\0":
        raise ValueError("not a PE image")
    nsections, = struct.unpack_from("<H", data, pe + 6)
    opt_size, = struct.unpack_from("<H", data, pe + 20)
    opt = pe + 24
    magic, = struct.unpack_from("<H", data, opt)
    if magic != 0x20B:
        raise ValueError("not a PE32+ image")
    subsystem, = struct.unpack_from("<H", data, opt + 0x44)
    # Data directory 1 is the import table (PE32+: directories start at +0x70).
    import_rva, import_size = struct.unpack_from("<II", data, opt + 0x70 + 8)
    sections = []
    for i in range(nsections):
        s = opt + opt_size + i * 40
        vsize, vaddr, rawsize, rawptr = struct.unpack_from("<IIII", data, s + 8)
        sections.append((vaddr, max(vsize, rawsize), rawptr))

    def at(rva):
        for vaddr, size, rawptr in sections:
            if vaddr <= rva < vaddr + size:
                return rawptr + (rva - vaddr)
        raise ValueError(f"rva {rva:#x} is in no section")

    dlls = []
    off = at(import_rva)
    while True:
        orig, stamp, chain, name_rva, first = struct.unpack_from("<IIIII", data, off)
        if not (orig or name_rva or first):
            break
        start = at(name_rva)
        dlls.append(data[start:data.index(b"\0", start)].decode())
        off += 20
    return subsystem, dlls


def version_key(v):
    return tuple(int(x) for x in v.split("."))


def main(directory):
    failures = []
    names = sorted(n for n in os.listdir(directory) if re.fullmatch(r"hx2-(darwin|linux|windows)-[a-z0-9-]+", n))
    for name in names:
        with open(os.path.join(directory, name), "rb") as f:
            data = f.read()
        if name.startswith("hx2-linux-"):
            glibc = sorted((v for v in elf_glibc_versions(data) if v.startswith("GLIBC_2.")), key=lambda v: version_key(v[6:]))
            newest = glibc[-1] if glibc else "none"
            ok = not glibc or version_key(newest[6:]) <= GLIBC_FLOOR
            print(f"{name}: {len(data)} bytes, newest glibc symbol {newest} ({' '.join(glibc)})")
            if not ok:
                failures.append(f"{name} needs {newest}, newer than glibc {'.'.join(map(str, GLIBC_FLOOR))}")
        elif name.startswith("hx2-windows-"):
            subsystem, dlls = pe_subsystem_and_imports(data)
            want = GUI if name.endswith("-svc") else CONSOLE
            kind = {CONSOLE: "console", GUI: "windowless"}.get(subsystem, f"subsystem {subsystem}")
            print(f"{name}: {len(data)} bytes, {kind}, imports {' '.join(dlls)}")
            if subsystem != want:
                failures.append(f"{name} is {kind}")
            runtime = [d for d in dlls if re.match(r"(?i)(vcruntime|msvcp)", d)]
            if runtime:
                failures.append(f"{name} imports the Visual C++ runtime: {' '.join(runtime)}")
        else:
            print(f"{name}: {len(data)} bytes")
    if not names:
        failures.append(f"no hx2 binaries in {directory}")
    for f in failures:
        print(f"FAIL: {f}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main(sys.argv[1])
