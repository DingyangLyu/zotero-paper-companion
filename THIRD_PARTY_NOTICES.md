# Third-party components

- KaTeX 0.18.4: MIT, `plugin/content/vendor/katex/LICENSE.txt`.
- marked 18.0.14: MIT, `plugin/content/vendor/marked-LICENSE.md`.

The original KaTeX browser bundle is compiled into an explicit global export for Gecko. No remote scripts are fetched at runtime. esbuild and jsdom are development dependencies and are not included in the installed plugin.
