/* Clay configuration page. Values are kept in the phone's localStorage ("clay-settings")
 * and are never sent to the watch. */
module.exports = [
  { "type": "heading", "defaultValue": "Leela" },
  {
    "type": "section",
    "items": [
      { "type": "heading", "defaultValue": "Server" },
      {
        "type": "input",
        "messageKey": "SERVER_URL",
        "label": "Server URL",
        "defaultValue": "https://chat.osmosis.page",
        "attributes": { "type": "url", "autocapitalize": "off", "autocorrect": "off", "spellcheck": "false" }
      },
      {
        "type": "input",
        "messageKey": "DEVICE_TOKEN",
        "label": "Device token",
        "description": "Starts with lpd_. Create one in the web admin: Leela tab, Pebble devices, Create device. Stored on this phone only.",
        "defaultValue": "",
        "attributes": { "type": "password", "autocapitalize": "off", "autocorrect": "off", "spellcheck": "false" }
      }
    ]
  },
  {
    "type": "section",
    "items": [
      { "type": "heading", "defaultValue": "Audio" },
      {
        "type": "toggle",
        "messageKey": "SPEAK_REPLIES",
        "label": "Speak replies",
        "description": "Not implemented yet (see README). Setting is stored for the future.",
        "defaultValue": false
      }
    ]
  },
  { "type": "submit", "defaultValue": "Save" }
];
