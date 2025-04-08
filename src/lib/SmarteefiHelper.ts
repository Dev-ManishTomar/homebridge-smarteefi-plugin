import { Characteristic } from "homebridge";
import { DeviceStatus } from "./Config";
import { MAX_FAN_SPEED_UNIT, BASE_FAN_SPEED } from "../constants";

const getReason = (code) => {
  switch (code) {
    case 6:
      return "Device offline";
    default:
      return "Unknown error: " + code;
  }
};

const decodeStatus = (sequence: number, deviceId: string, characteristic: typeof Characteristic, deviceStatus: DeviceStatus) => {
  const switchmap = getSwitchMap(sequence);
  let statusmap = deviceStatus.getStatusMap(deviceId)?.statusmap || 0;
  statusmap &= switchmap;
  if (statusmap == 0) {
    return characteristic.Active.INACTIVE
  } else {
    return characteristic.Active.ACTIVE
  }
}

const getSwitchMap = (sequence: number) => {
  return Math.pow(2, sequence);
}


const getSwitchStatusMap = (_this) => {
  return _this.deviceStatus.getStatusMap(_this.accessory.context.device.id)?.statusmap || 0;
}

const getSpeedFromStatusMap = (statusmap, switchmap) => {
  statusmap &= switchmap;
  if (statusmap === 0 || statusmap === BASE_FAN_SPEED) {
    return 0;
  } else {
    if (statusmap > BASE_FAN_SPEED)
      statusmap -= BASE_FAN_SPEED;
    return ((statusmap) / MAX_FAN_SPEED_UNIT) * 100;
  }
}


const getSpeedFromFloat = (value) => {
  return (Math.floor(Number(value) / (100 / MAX_FAN_SPEED_UNIT)) + BASE_FAN_SPEED);
}

const setCorrectDeviceID = (id) => {
  const idSplit = id.split('-');
  return idSplit[0];
}

/**
 * Converts an API speed value (1-4) to a HomeKit percentage (0-100).
 * Returns 0 if the input is null, undefined, or invalid.
 */
export function valueToPercent(value: number | null | undefined): number {
  if (value === null || value === undefined || value <= 0) {
      return 0;
  }
  switch (value) {
      case 1: return 25;
      case 2: return 50;
      case 3: return 75;
      case 4: return 100;
      default: // If value is > 4, cap at 100, otherwise treat as invalid (0)
          return value > 4 ? 100 : 0;
  }
}

export {
  getReason,
  decodeStatus,
  getSwitchStatusMap,
  getSwitchMap,
  getSpeedFromStatusMap,
  getSpeedFromFloat,
  setCorrectDeviceID
}