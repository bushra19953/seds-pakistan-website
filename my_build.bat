@echo off
set GOOGLE_APPLICATION_CREDENTIALS=e:\SEDS WEBSITE UPDATED SHIT\seds-pakistan-service-account.json
set FIREBASE_PROJECT_ID=seds-pakistan
echo Starting Build with Service Account... > build_output_final.txt
npm run build >> build_output_final.txt 2>&1
echo Build Finished. >> build_output_final.txt
