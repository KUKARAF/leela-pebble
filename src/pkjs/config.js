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
        "description": "Read the first part of each reply aloud through the watch speaker (Pebble Time 2). Needs a text-to-speech model selected on the server. Press BACK or SELECT to stop. Skipped silently if the speaker is muted or Quiet Time is on.",
        "defaultValue": false
      },
      {
        "type": "select",
        "messageKey": "SPEAK_QUALITY",
        "label": "Voice quality",
        "description": "Higher quality sends more data to the watch and may stutter over a slow Bluetooth link.",
        "defaultValue": "fast",
        "options": [
          { "label": "Fast (8 kHz, 8 bit)", "value": "fast" },
          { "label": "Good (8 kHz, 16 bit)", "value": "good" },
          { "label": "Best (16 kHz, 16 bit)", "value": "best" }
        ]
      }
    ]
  },
  { "type": "submit", "defaultValue": "Save" }
];
