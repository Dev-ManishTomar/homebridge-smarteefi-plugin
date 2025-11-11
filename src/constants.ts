const PLATFORM_NAME = "Smarteefi-plugin";  // Must match config.schema.json pluginAlias
const PLUGIN_NAME = "homebridge-smarteefi-plugin";
const MAX_FAN_SPEED_UNIT = 4;
const BASE_FAN_SPEED = 158;
const FAN_APPLIANCE_MAP = 112;
const STRINGS = {
    SWITCH: "Smart Switch",
    FAN: "Smart Fan",
    BRAND: "Smarteefi"
};

export {
    PLATFORM_NAME,
    PLUGIN_NAME,
    MAX_FAN_SPEED_UNIT,
    BASE_FAN_SPEED,
    FAN_APPLIANCE_MAP,
    STRINGS
};