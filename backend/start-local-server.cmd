@echo off
cd /d "%~dp0"
node server.js > server.out 2> server.err
