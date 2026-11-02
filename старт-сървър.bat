@echo off
chcp 65001 >nul
title Преведени субтитри - сървър
cd /d F:\addon
echo ============================================
echo  Сървърът върви ДОКАТО е отворен този прозорец
echo  Линк за Stremio/Nuvio:
echo  http://localhost:7000/manifest.json
echo ============================================
node src\server.js
pause
