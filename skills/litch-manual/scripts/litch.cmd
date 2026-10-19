@echo off
rem Litch configuration command: hands its arguments to the config subcommand of the adapter bundled
rem with Litch. Litch rewrites the path below every time it starts.
"{{ADAPTER}}" config %*
