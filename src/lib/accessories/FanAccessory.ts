// src/lib/accessories/FanAccessory.ts

import { Service, PlatformAccessory, CharacteristicValue, Characteristic } from 'homebridge'; // Added NumericCharacteristic for type check
import { SmarteefiPlatform } from '../../platform';
import * as SmarteefiHelper from '../SmarteefiHelper';
import { STRINGS } from '../../constants';
import { BaseAccessory } from './BaseAccessory';

// Assume SmarteefiHelper.valueToPercent exists

export class FanAccessory extends BaseAccessory {

    private currentActiveState: CharacteristicValue = this.platform.Characteristic.Active.INACTIVE;
    private currentSpeedPercent: CharacteristicValue = 0;

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
        const speedToReturn = this.currentSpeedPercent;
        this.platform.log.info(`GET RotationSpeed for ${this.accessory.displayName}: Returning cached speed ${speedToReturn}%`);
        return speedToReturn;
    }

    async getONOFFState(): Promise<CharacteristicValue> {
        const stateToReturn = this.currentActiveState;
        this.platform.log.info(`GET Active state for ${this.accessory.displayName}: Returning cached state ${stateToReturn}`);
        return stateToReturn;
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
        if (this.currentActiveState === this.platform.Characteristic.Active.INACTIVE) {
             this.platform.log.debug(`SET Speed > 0: Ensuring Active state is ON internally.`);
             this.currentActiveState = this.platform.Characteristic.Active.ACTIVE;
             this.service?.updateCharacteristic(this.platform.Characteristic.Active, this.currentActiveState);
        }

        const apiHelper = this.platform.apiHelper;
        if (!apiHelper || !this.accessory.context?.device) {
            this.platform.log.error(`API Helper or device context not available for ${this.accessory.displayName}. Cannot set speed.`);
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        const deviceId = this.accessory.context.device.id;
        const deviceIp = this.accessory.context.device.ip;

        try {
            await apiHelper.setFanSpeed(
                deviceId, deviceIp, requestedSpeedPercent,
                (response) => {
                    if (response && response.result === 'success' && response.status !== undefined && response.value !== undefined) {
                        this.platform.log.info(`API call to set fan speed for ${this.accessory.displayName} successful.`);
                        const apiReportedSpeedValue = response.value;
                        const apiReportedOnState = response.status === 1;
                        const newActiveState = apiReportedOnState ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE;
                        const newSpeedPercent = SmarteefiHelper.valueToPercent(apiReportedSpeedValue);

                        this.platform.log.info(`[CACHE_UPDATE / setSpeed] Internal state updated for ${deviceId}: Active=${newActiveState}, Speed=${newSpeedPercent}%`);
                        this.currentActiveState = newActiveState;
                        this.currentSpeedPercent = newSpeedPercent;

                        // Optional local updates
                        // if (this.service?.getCharacteristic(this.platform.Characteristic.Active).value !== this.currentActiveState) { ... }
                        // if (this.service?.getCharacteristic(this.platform.Characteristic.RotationSpeed).value !== this.currentSpeedPercent) { ... }

                    } else if (response && response.result === 'success') {
                        this.platform.log.warn(`Set fan speed API call succeeded but did not return status/value. Internal cache not updated.`);
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

        // Avoid redundant calls
        // ** FIX 3a: Type check currentActiveState before comparing **
        if (typeof this.currentActiveState === 'number' && targetStateHK === this.currentActiveState) {
            this.platform.log.info(`SET Active request for ${this.accessory.displayName} to ${targetState}, but already in that state. Skipping API call.`);
            return;
        }
        this.platform.log.info(`SET Active request for ${this.accessory.displayName} to ${targetState}`);

        const apiHelper = this.platform.apiHelper;
        if (!apiHelper || !this.accessory.context?.device) { /* ... error handling ... */ throw new Error("API Helper or context missing"); }

        const deviceId = this.accessory.context.device.id;
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

                        // Update internal state cache
                        this.currentActiveState = targetStateHK; // Update Active state

                        let speedToCache: number;
                        // ** FIX 1 & 3b: Check type of currentSpeedPercent before comparison/assignment **
                        const currentSpeedNum = typeof this.currentSpeedPercent === 'number' ? this.currentSpeedPercent : 0;

                        if (targetState === 'OFF') {
                            speedToCache = 0; // Set speed to 0 when turning off
                        } else {
                            // If turning ON, restore last known speed OR default to 25%
                            // ** FIX 3c: Use the checked currentSpeedNum **
                            speedToCache = currentSpeedNum > 0 ? currentSpeedNum : 25;
                        }
                        this.currentSpeedPercent = speedToCache; // Update speed cache

                        this.platform.log.info(`[CACHE_UPDATE / setONOFFState] Internal state updated: Active=${this.currentActiveState}, Speed=${this.currentSpeedPercent}%`);

                        // Update speed characteristic locally for immediate feedback
                        // ** FIX 3d: Add null check for service **
                        if (this.service && this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed).value !== this.currentSpeedPercent){
                             this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.currentSpeedPercent);
                        }

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