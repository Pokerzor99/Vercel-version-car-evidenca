# Firebase + Netlify (ta različica aplikacije)

## Firebase (Firestore)

1. V [Firebase Console](https://console.firebase.google.com/) ustvari projekt (ali uporabi obstoječega).
2. **Build → Firestore Database → Create database** (način lahko začasno v **test** načinu za razvoj).
3. **Project settings → Your apps → Web** → registriraj aplikacijo in kopiraj config v `firebase-config.js` (zamenjaj `YOUR_*` vrednosti).

### Zbirke (collections)

| Zbirka     | ID dokumenta | Polja |
|------------|----------------|-------|
| `vehicles` | `id` vozila    | `nickname`, `year`, `make`, `model`, `referenceMarketValue`, `baseMileage`, `currentMileage` |
| `plans`    | `id` plana     | `vehicleId`, `type`, `intervalMiles`, `intervalDays`, `lastServiceDate`, `lastServiceMileage`, `notes` |
| `records`  | `id` zapisa    | `vehicleId`, `type`, `serviceDate`, `mileageAtService`, `cost`, `shopName`, `notes` |
| `vinjetas` | = `vehicleId`  | `vehicleId`, `si` (ISO datum ali null), `at` (ISO datum ali null) |

Aplikacija **ne uporablja Firebase Auth**; pravila morajo omogočati branje/pisanje brez prijave (za zasebno stran) ali jih prilagodiš (npr. samo z znanim API ključem ni varnosti – za resno zaščito dodaj Auth ali backend).

### Primer pravil (samo zasebno testiranje)

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /vehicles/{id} { allow read, write: if true; }
    match /plans/{id} { allow read, write: if true; }
    match /records/{id} { allow read, write: if true; }
    match /vinjetas/{id} { allow read, write: if true; }
  }
}
```

**Opozorilo:** `if true` pomeni, da lahko kdorkoli s projektom ID in javnim API ključem bere/piše podatke. Za resno zaščito dodaj Firebase Auth ali backend.

## Netlify

1. Repozitorij / mapo `car-maintenance-app-firebase` poveži z Netlify (**Add new site → Import**).
2. **Build command:** pusti prazno. **Publish directory:** `.` (root te mape).
3. `netlify.toml` je že pripravljen.

## Lokalno testiranje

Odpri `index.html` prek lokalnega strežnika (ne `file://`, če brskalnik blokira module/CORS). Npr. v mapi:

`npx serve .`

ali VS Code Live Server.
