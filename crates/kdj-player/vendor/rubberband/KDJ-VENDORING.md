# Vendored Rubber Band Library

KDJ builds the official Rubber Band Library 4.0.0 single-file compilation
unit from this directory. The upstream release archive is available at:

<https://breakfastquay.com/files/releases/rubberband-4.0.0.tar.bz2>

Upstream SHA-256:

`af050313ee63bc18b35b2e064e5dce05b276aaf6d1aa2b8a82ced1fe2f8028e9`

Only the library sources and their public headers are retained. KDJ uses the
single-file configuration's built-in resampler and built-in FFT, except on
Apple platforms where Rubber Band uses the Accelerate/vDSP FFT. No upstream
source file has been modified.

Rubber Band is Copyright 2007-2024 Particular Programs Ltd and is distributed
under GPL-2.0-or-later. See `COPYING` and `README.md` in this directory.
