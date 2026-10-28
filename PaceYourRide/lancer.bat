@echo off
cd /d "%~dp0"
echo PaceYourRide : serveur local sur http://localhost:8000 (fermer cette fenetre pour l'arreter)
start "" cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:8000/accueil.html"
py -m http.server 8000
