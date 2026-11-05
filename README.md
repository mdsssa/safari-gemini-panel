# Gemini Panel for Safari

Side panel with Gemini that can see the current page. Safari Web Extension (macOS).

## Requirements
- macOS with full Xcode (`sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`)
- Free Apple ID added in Xcode > Settings > Accounts
- A Gemini API key: https://aistudio.google.com/apikey

## Build
Find your Team ID:

    security find-certificate -c "Apple Development" -p | openssl x509 -noout -subject

(the `OU=` value). Then:

    TEAM_ID=YOURTEAMID BUNDLE_ID=com.yourname.geminipanel ./build.sh

Enable the extension in Safari > Settings > Extensions, allow it on all websites,
click its toolbar icon and paste the API key in the panel settings.

## Notes
- Free Apple ID profiles expire after about 7 days; just run `build.sh` again.
- Models are listed in `extension/background.js` (`MODELS`); the first one that answers wins.
- The key is stored locally in the extension and is never part of this repo.
