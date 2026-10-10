# Acknowledgements

## claude-code-filetree

The File Viewer's rows Client (`mods/file-viewer/hooks/rows.ts`: a surface module that draws the list, with hover,
click, drag-to-scroll and a shimmer band over the name of the file being worked on) follows the structure of
`hooks/rows.tsx` and the way `hooks/register.tsx` mounts it in **claude-code-filetree** by Kurt Buhler
(<https://github.com/data-goblin/claude-code-filetree>). The shimmer (a band moving on a short tick, only while
something is lit) is adapted from it. The data model, palette and the rest of the code are this project's own.

It is used under the MIT License:

```
MIT License

Copyright (c) 2026 Kurt Buhler

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## nvim-web-devicons

The per-language icon colours in `mods/file-viewer/src/view/icons.ts` (the `c` value of each file-type entry, for
TypeScript, JavaScript, JSON, Markdown, Python, Go, Rust, shell, YAML, CSS, HTML and the other listed types) are
taken from **nvim-web-devicons** (<https://github.com/nvim-tree/nvim-web-devicons>, `default/icons_by_file_extension.lua`
and `default/icons_by_filename.lua` on `master`, October 2026). The glyph table itself is this project's own, built
from the Nerd Fonts cheat sheet (<https://www.nerdfonts.com/cheat-sheet>).

It is used under the MIT License:

```
MIT License

Copyright (c) 2023 nvim-tree

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
