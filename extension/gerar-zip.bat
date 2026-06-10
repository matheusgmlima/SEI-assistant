@echo off
REM Gera o ZIP da extensao (build + empacotamento) em Downloads.
REM Duplo-clique neste arquivo ou rode: gerar-zip.bat
cd /d "%~dp0"
echo Gerando o pacote da extensao...
call npm run package
echo.
pause
