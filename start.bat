@echo off
chcp 65001 > nul
title AutoQ - Список имён
echo ===================================================
echo          Запуск сайта AutoQ (Список имён)
echo ===================================================
echo.
echo Открытие сайта в браузере...
start http://localhost:5000
echo.
echo Запуск веб-сервера...
py app.py
pause
