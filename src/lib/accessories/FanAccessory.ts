// src/lib/accessories/FanAccessory.ts

import { Service, PlatformAccessory, CharacteristicValue, Characteristic } from 'homebridge'; // Added NumericCharacteristic for type check
import { SmarteefiPlatform } from '../../platform';
import * as SmarteefiHelper from '../SmarteefiHelper';
import { STRINGS } from '../../constants';
import { BaseAccessory } from './BaseAccessory';

// Assume SmarteefiHelper.valueToPercent exists

export class FanAccessory extends BaseAccessory {

    constructor(
        platform: SmarteefiPlatform,
        accessory: PlatformAccessory,
    ) {
        super(platform, accessory);

        // ... constructor service setup ...
        if (this.accessoryService) {
            this.accessoryService.setCharacteristic(this.platform.Characteristic.Model, STRINGS.FAN);
        }
        try {
            this.service = this.accessory.getService(this.platform.Service.Fanv2)
                || this.accessory.addService(this.platform.Service.Fanv2, this.accessory.displayName);
        } catch (error) {
            this.platform.log.error(`Failed to get or add Fanv2 service for ${this.accessory.displayName}: ${error}`);
            return;
        }
        this.platform.log.debug(`Setting up Fanv2 service for ${this.accessory.displayName}`);
        // No initial state fetch needed - rely on cache or first GET/SET

        // Register Handlers
        this.service.getCharacteristic(this.platform.Characteristic.Active)
            .onGet(this.getONOFFState.bind(this))
            .onSet(this.setONOFFState.bind(this));
        this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
            .onGet(this.getSpeed.bind(this))
            .onSet(this.setSpeed.bind(this));
    }

    // --- GET Handlers ---
    async getSpeed(): Promise<CharacteristicValue> {
        const deviceId = this.accessory.context.device.id;
        const currentDeviceStatus = this.deviceStatus.getStatusMap(deviceId);
        
        // Get speedValue from cache and convert to percentage
        const speedValue = currentDeviceStatus?.speedValue ?? null;
        let speedPercent = 0;
        
        if (speedValue !== null && speedValue > 0) {
            speedPercent = SmarteefiHelper.valueToPercent(speedValue);
        } else if (currentDeviceStatus?.statusmap === 0) {
            // Device is OFF
            speedPercent = 0;
        } else {
            // No speed info but device might be on - default to 25%
            speedPercent = 0;
        }
        
        this.platform.log.info(`GET RotationSpeed for ${this.accessory.displayName}: Returning speed ${speedPercent}% (speedValue=${speedValue})`);
        return speedPercent;
    }

    async getONOFFState(): Promise<CharacteristicValue> {
        const deviceId = this.accessory.context.device.id;
        const currentDeviceStatus = this.deviceStatus.getStatusMap(deviceId);
        const statusmap = currentDeviceStatus?.statusmap ?? 0;
        
        this.platform.log.debug(`GET Active for ${this.accessory.displayName}: DeviceId=${deviceId}, StatusMap=${statusmap}`);
        
        if (statusmap === -1) {
            this.platform.log.warn(`GET Active for ${this.accessory.displayName}: Status is marked as errored (-1).`);
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        
        // Simple logic: statusmap 0 = OFF, anything else = ON
        const isActive = statusmap === 0 ? this.platform.Characteristic.Active.INACTIVE : this.platform.Characteristic.Active.ACTIVE;
        
        this.platform.log.info(`GET Active state for ${this.accessory.displayName}: Returning ${isActive === 0 ? 'INACTIVE' : 'ACTIVE'} (statusmap=${statusmap})`);
        return isActive;
    }

    // --- SET Handlers ---
    async setSpeed(value: CharacteristicValue): Promise<void> {
        const requestedSpeedPercent = value as number; // Assume RotationSpeed value is always number
        this.platform.log.info(`SET RotationSpeed request for ${this.accessory.displayName} to ${requestedSpeedPercent}%`);

        if (requestedSpeedPercent <= 0) {
            this.platform.log.warn(`RotationSpeed set to ${requestedSpeedPercent}%. Triggering OFF state via setONOFFState.`);
            return await this.setONOFFState(this.platform.Characteristic.Active.INACTIVE);
        }

        // Ensure Active state is ON locally if setting speed > 0
        const deviceId = this.accessory.context.device.id;
        const currentDeviceStatus = this.deviceStatus.getStatusMap(deviceId);
        const currentStatusmap = currentDeviceStatus?.statusmap ?? 0;
        
        if (currentStatusmap === 0) {
             this.platform.log.debug(`SET Speed > 0: Ensuring Active state is ON internally.`);
             this.service?.updateCharacteristic(this.platform.Characteristic.Active, this.platform.Characteristic.Active.ACTIVE);
        }

        const apiHelper = this.platform.apiHelper;
        if (!apiHelper || !this.accessory.context?.device) {
            this.platform.log.error(`API Helper or device context not available for ${this.accessory.displayName}. Cannot set speed.`);
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        const deviceIp = this.accessory.context.device.ip;

        try {
            await apiHelper.setFanSpeed(
                deviceId, deviceIp, requestedSpeedPercent,
                (response) => {
                    if (response && response.result === 'success' && response.status !== undefined && response.value !== undefined) {
                        this.platform.log.info(`API call to set fan speed for ${this.accessory.displayName} successful.`);
                        const apiReportedSpeedValue = response.value;
                        const apiReportedOnState = response.status === 1;
                        const newStatusmap = apiReportedOnState ? 112 : 0; // Fan uses statusmap 112 for ON, 0 for OFF

                        this.platform.log.info(`[CACHE_UPDATE / setSpeed] Updating DeviceStatus cache for ${deviceId}: statusmap=${newStatusmap}, speedValue=${apiReportedSpeedValue}`);
                        
                        // Update the shared DeviceStatus cache with the new state and speed
                        this.deviceStatus.setStatusMap(deviceId, 112, newStatusmap, apiReportedSpeedValue);

                    } else if (response && response.result === 'success') {
                        this.platform.log.warn(`Set fan speed API call succeeded but did not return status/value. DeviceStatus cache not updated.`);
                    } else {
                        this.platform.log.error(`API call failed to set fan speed for ${this.accessory.displayName}: ${response?.reason || 'Unknown API error'}`);
                    }
                }
            );
            this.platform.log.debug(`setFanSpeed promise resolved for ${this.accessory.displayName}`);
        } catch (error) {
             const errorMessage = error instanceof Error ? error.message : String(error);
             this.platform.log.error(`Error setting fan speed for ${this.accessory.displayName}: ${errorMessage}`);
             throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }

    async setONOFFState(value: CharacteristicValue): Promise<void> {
        const targetStateHK = value as number; // Active characteristic value is number (0 or 1)
        const targetState = targetStateHK === this.platform.Characteristic.Active.ACTIVE ? 'ON' : 'OFF';

        const deviceId = this.accessory.context.device.id;
        this.platform.log.info(`SET Active request for ${this.accessory.displayName} to ${targetState}`);

        const apiHelper = this.platform.apiHelper;
        if (!apiHelper || !this.accessory.context?.device) { /* ... error handling ... */ throw new Error("API Helper or context missing"); }

        const deviceIp = this.accessory.context.device.ip;
        const sequence = this.accessory.context.device.sequence;

        const inputStatusmapForHelper = targetState === 'ON' ? 1 : 0;
        const switchmap = SmarteefiHelper.getSwitchMap(sequence);

        try {
            await apiHelper.setSwitchStatus(
                deviceId, deviceIp, switchmap, inputStatusmapForHelper, true,
                (response) => {
                    if (response && response.result === 'success') {
                        this.platform.log.info(`API call to set fan ${targetState} for ${this.accessory.displayName} successful.`);

                        // Update DeviceStatus cache
                        const newStatusmap = targetState === 'ON' ? 112 : 0;
                        
                        // Get current speed value from cache to preserve it when turning ON/OFF
                        const cachedStatus = this.deviceStatus.getStatusMap(deviceId);
                        const currentSpeed = cachedStatus?.speedValue ?? null;
                        let speedToStore: number | null;

                        if (targetState === 'OFF') {
                            // When turning OFF, clear the speed in cache
                            speedToStore = null;
                        } else {
                            // If turning ON, preserve last known speed OR default to 1 (25%)
                            speedToStore = (currentSpeed && currentSpeed > 0) ? currentSpeed : 1;
                        }

                        this.platform.log.info(`[CACHE_UPDATE / setONOFFState] Updating DeviceStatus cache for ${deviceId}: statusmap=${newStatusmap}, speedValue=${speedToStore}`);
                        
                        // Update cache FIRST before any characteristic updates
                        this.deviceStatus.setStatusMap(deviceId, 112, newStatusmap, speedToStore);
                        
                        this.platform.log.info(`Cache updated. Now updating HomeKit characteristics for ${this.accessory.displayName}...`);

                    } else {
                        this.platform.log.error(`API call failed to set fan ${targetState} for ${this.accessory.displayName}: ${response?.reason || 'Unknown error'}`);
                        // Do not update cache on failure
                    }
                }
            );
            this.platform.log.debug(`setSwitchStatus promise resolved for ${this.accessory.displayName}`);
        } catch (error) {
             const errorMessage = error instanceof Error ? error.message : String(error);
             this.platform.log.error(`Error setting fan ${targetState} for ${this.accessory.displayName}: ${errorMessage}`);
             throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }
} // End Class FanAccessory