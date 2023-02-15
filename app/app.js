import express from 'express';
import winston from 'winston';
import expressWinston from 'express-winston';
import { expressjwt } from 'express-jwt';
import jwksRsa from 'jwks-rsa';
import bodyParser from 'body-parser';
import { smarthome } from 'actions-on-google';
import ecovacsDeebot from 'ecovacs-deebot';
import nodeMachineId from 'node-machine-id';
import { pEvent, pEventIterator } from 'p-event';

const capacityRange = [
  {
    value: "CRITICALLY_LOW",
    min: "0",
    max: "10"
  },
  {
    value: "LOW",
    min: "11",
    max: "30"
  },
  {
    value: "MEDIUM",
    min: "31",
    max: "60"
  },
  {
    value: "HIGH",
    min: "61",
    max: "90"
  },
  {
    value: "FULL",
    min: "91",
    max: "100"
  }
]

const EcoVacsAPI = ecovacsDeebot.EcoVacsAPI;
const firstDeviceId = 0; // The first vacuum from your account
const deviceId = EcoVacsAPI.getDeviceId(nodeMachineId.machineIdSync(), firstDeviceId);

const app = express();

app.use(bodyParser.json());

app.use(expressWinston.logger({
  transports: [
    new winston.transports.Console()
  ],
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.json()
  ),
  meta: true, // optional: control whether you want to log the meta data about the request (default to true)
  msg: "HTTP {{req.method}} {{req.url}}", // optional: customize the default logging message. E.g. "{{res.statusCode}} {{req.method}} {{res.responseTime}}ms {{req.url}}"
  expressFormat: true, // Use the default Express/morgan request formatting. Enabling this will override any msg if true. Will only output colors with colorize set to true
  colorize: false, // Color the text and status code, using the Express/morgan color palette (text: gray, status: default green, 3XX cyan, 4XX yellow, 5XX red).
  ignoreRoute: function (req, res) { return false; } // optional: allows to skip some log messages based on request and/or response
}));


app.use(expressjwt({
  // Dynamically provide a signing key based on the kid in the header and the signing keys provided by the JWKS endpoint.
  secret: jwksRsa.expressJwtSecret({
    cache: true,
    rateLimit: true,
    jwksRequestsPerMinute: 5,
    jwksUri: `http://keycloak:8080/auth/realms/smarthome/protocol/openid-connect/certs`
  }),
  // Validate the audience and the issuer.
  // audience: 'urn:my-resource-server',
  issuer: 'https://francarl77.ns0.it/auth/realms/smarthome',
  algorithms: [ 'RS256' ]
}));

app.use(function (req, res, next) {
  req.headers['ecovacs-username'] = req.auth['ecovacs-username'];
  req.headers['ecovacs-password'] = req.auth['ecovacs-password'];
  req.headers['ecovacs-country'] = req.auth['ecovacs-country'];
  next();
});


let router = express.Router();

const smarthomeApp = smarthome();

smarthomeApp.onSync(async (body, headers) => {

  // get information from ecovacs 
  const countryCode = headers['ecovacs-country'];
  const continent = ecovacsDeebot.countries[countryCode.toUpperCase()].continent.toLowerCase();
  const username = headers['ecovacs-username'];
  const password = EcoVacsAPI.md5(headers['ecovacs-password']);
  const authDomain = '';

  let api = new EcoVacsAPI(deviceId, countryCode, continent, authDomain);

  const response = await api.connect(username, password);
  const devices =  await api.devices();

  let vacuum = devices[firstDeviceId];

  let modes = [
    {
      "setting_name": "kitchen",
      "setting_values": [
        {
          "setting_synonym": [
            "kitchen"
          ],
          "lang": "en"
        },
        {
          "setting_synonym": [
            "cucina"
          ],
          "lang": "it"
        },
      ]
    },
    {
      "setting_name": "living_room",
      "setting_values": [
        {
          "setting_synonym": [
            "living_room"
          ],
          "lang": "en"
        },
        {
          "setting_synonym": [
            "soggiorno"
          ],
          "lang": "it"
        },
      ]
    },
    {
      "setting_name": "reading_light",
      "setting_values": [
        {
          "setting_synonym": [
            "reading",
            "ambiant"
          ],
          "lang": "en"
        }
      ]
    }
  ];

  const syncResponse = {
    requestId: body.requestId,
    payload: {
      agentUserId: username,
      devices: [
        {
          id: vacuum.did,
          type: "action.devices.types.VACUUM",
          traits: [
            "action.devices.traits.Dock",
            "action.devices.traits.EnergyStorage",
            "action.devices.traits.StartStop"
          ],
          name: {
            name: vacuum.nick
          },
          willReportState: true,
          attributes: {
            queryOnlyEnergyStorage: true,
            pausable: true,
            availableZones: [
              "kitchen",
              "living room",
              "office",
              "bedroom"
            ]
          },
          deviceInfo: {
            manufacturer: "Ecovacs",
            model: vacuum.deviceName,
            hwVersion: "TBD",
            swVersion: "TDB"
          }
        }
      ]
    }
  };

  return syncResponse;
});


smarthomeApp.onQuery(async (body, headers) => {

  // get information from ecovacs 
  const countryCode = headers['ecovacs-country'];
  const continent = ecovacsDeebot.countries[countryCode.toUpperCase()].continent.toLowerCase();
  const username = headers['ecovacs-username'];
  const password = EcoVacsAPI.md5(headers['ecovacs-password']);
  const authDomain = '';

  let api = new EcoVacsAPI(deviceId, countryCode, continent, authDomain);

  const response = await api.connect(username, password);
  const devices =  await api.devices();

  const intent = body.inputs[0];
  const deviceID = intent.payload.devices[0].id;

  let vacuum = devices.find(e => e.did == deviceID);

  let vacbot = api.getVacBot(api.uid, EcoVacsAPI.REALM, api.resource, 
      api.user_access_token, vacuum, continent);

  vacbot.connect();

  const ready = await pEvent(vacbot.ecovacs, "ready");

  let infos = [];
  vacbot.run("GetBatteryState");
  for await (const event of pEventIterator(vacbot.ecovacs, ['HeaderInfo', 'BatteryInfo', 'BatteryIsLow'], {
    resolutionEvents: ['BatteryIsLow']
  })) {
    infos.push(event);
  }
  const battery = infos[1];
  let capacityRemaining = capacityRange.filter(i => battery >= i.min && battery <= i.max)[0].value;

  infos = [];
  vacbot.run("GetCleanState");
  for await (const event of pEventIterator(vacbot.ecovacs, ['HeaderInfo', 'CleanReport', 'CurrentCustomAreaValues', 'CurrentSpotAreas', 'ChargeState', 'ChargeMode'], {
    resolutionEvents: ['ChargeMode']
  } )) {
    infos.push(event);
  }

  const cleanStatus = infos[0];
  const chargeState = infos[3];

  let payload = {
    devices: {}
  };

  payload.devices[deviceID] = {
    status: "SUCCESS",
    online: vacuum.status == 1 ? true : false,
    isRunning: cleanStatus == 'idle' ? false : true,
    isPaused: false,
    isDocked: chargeState == 'charging' ? true : false,
    descriptiveCapacityRemaining: capacityRemaining
  };

  let queryResponse = 
  {
    requestId: body.requestId,
    payload: payload
  };

  console.log("***************************************************");
  console.log("queryResponse: %j", queryResponse);
  console.log("***************************************************");
  
  return queryResponse;
});


smarthomeApp.onExecute(async (body, headers) => {

  console.log("***************************************************");
  console.log("Body: %j", body);
  console.log("***************************************************");

  // get information from ecovacs 
  const countryCode = headers['ecovacs-country'];
  const continent = ecovacsDeebot.countries[countryCode.toUpperCase()].continent.toLowerCase();
  const username = headers['ecovacs-username'];
  const password = EcoVacsAPI.md5(headers['ecovacs-password']);
  const authDomain = '';

  let api = new EcoVacsAPI(deviceId, countryCode, continent, authDomain);

  const response = await api.connect(username, password);
  const devices =  await api.devices();

  const intent = body.inputs[0];
  const deviceID = intent.payload.commands[0].devices[0].id;
  const execution = intent.payload.commands[0].execution[0];


  let vacuum = devices.find(e => e.did == deviceID);

  let vacbot = api.getVacBot(api.uid, EcoVacsAPI.REALM, api.resource, 
      api.user_access_token, vacuum, continent);

  vacbot.connect();

  const ready = await pEvent(vacbot.ecovacs, "ready");

  if (execution.command == "action.devices.commands.StartStop") {
      if (execution.params.start == true) {

      }
      if (execution.params.start == false) {
      
      }


  }

  
  return {};
});

router.post('/', smarthomeApp);

app.use("/smarthome", router);

app.listen(3000, function() {
  console.log("Listening 5 on port 3000");
});
