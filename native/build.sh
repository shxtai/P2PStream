#!/bin/sh
# Сборка p2paudio.exe из p2paudio.c и встраивание его в native.ts.
# Требуется mingw-w64 (x86_64-w64-mingw32-gcc) или zig cc.
# ./build.sh                      — zig cc
# CC=x86_64-w64-mingw32-gcc ./build.sh
set -e
cd "$(dirname "$0")"

if [ -n "$CC" ]; then
    $CC -O2 -s -Wall -o p2paudio.exe p2paudio.c -lole32
else
    ZIG="${ZIG:-zig}"
    $ZIG cc -target x86_64-windows-gnu -O2 -s -Wall -o p2paudio.exe p2paudio.c -lole32
fi

python3 - <<'EOF'
import base64
import re

b64 = base64.b64encode(open('p2paudio.exe', 'rb').read()).decode()
lines = [b64[i:i + 200] for i in range(0, len(b64), 200)]
joined = ' +\n    "' + '"\n    + "'.join(lines) + '"'

p = '../native.ts'
src = open(p).read()
src, n = re.subn(
    r'const P2P_AUDIO_EXE_B64 = .*?;\n',
    'const P2P_AUDIO_EXE_B64 = ' + joined + ';\n',
    src,
    count=1,
    flags=re.S,
)
assert n == 1, 'P2P_AUDIO_EXE_B64 placeholder not found in native.ts'
open(p, 'w').write(src)
print('embedded OK, b64 len:', len(b64))
EOF
