/**
 * Complete FanAccessory.ts file
 * Incorporates setFanSpeed for rotation control and uses setSwitchStatus for ON/OFF.
 */
import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { SmarteefiPlatform } from '../../platform'; // Adjust path if needed
// Assuming these are needed by BaseAccessory or GET handlers
// import { Config, DeviceStatus, Status } from '../Config'; // Adjust path if needed
// SmarteefiAPIHelper is accessed via platform.apiHelper
// import { SmarteefiAPIHelper } from '../SmarteefiAPIHelper'; // Adjust path if needed
import * as SmarteefiHelper from '../SmarteefiHelper'; // Adjust path if needed
import { STRINGS, MAX_FAN_SPEED_UNIT, BASE_FAN_SPEED } from '../../constants'; // Adjust path if needed
import { BaseAccessory } from './BaseAccessory'; // Adjust path if needed

export class FanAccessory extends BaseAccessory {

    constructor(
        platform: SmarteefiPlatform,
        accessory: PlatformAccessory,
    ) {
        super(platform, accessory);

        // Set AccessoryInformation characteristics (assuming accessoryService is defined in BaseAccessory)
        if (this.accessoryService) {
            this.accessoryService.setCharacteristic(this.platform.Characteristic.Model, STRINGS.FAN);
        }

        // Ensure the Fanv2 service exists or create it
        // Store the service instance on the class for easy access
        this.service = this.accessory.getService(this.platform.Service.Fanv2)
            || this.accessory.addService(this.platform.Service.Fanv2, this.accessory.displayName);

        this.platform.log.debug(`Setting up Fanv2 service for ${this.accessory.displayName}`);

        // --- Register Handlers ---

        // Active (ON/OFF) Characteristic
        this.service.getCharacteristic(this.platform.Characteristic.Active)
            .onGet(this.getONOFFState.bind(this))
            .onSet(this.setONOFFState.bind(this));

        // Rotation Speed Characteristic
        this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
            .onGet(this.getSpeed.bind(this))
            .onSet(this.setSpeed.bind(this));
    }

    // --- GET Handlers ---

    /**
     * Get the current Fan Rotation Speed (%) from the device status.
     */
    async getSpeed(): Promise<CharacteristicValue> {
        // Optional: uncomment below to force a status refresh before getting value
        // await this.platform.refreshStatus(this.platform, false);

        const switchmap = SmarteefiHelper.getSwitchMap(this.accessory.context.device.sequence);
        // Use a default statusmap of 0 if device status is not yet available
        const statusmap = this.deviceStatus.getStatusMap(this.accessory.context.device.id)?.statusmap ?? 0;

        // Assuming SmarteefiHelper converts the device's statusmap to a percentage (0-100)
        const currentSpeedPercent = SmarteefiHelper.getSpeedFromStatusMap(statusmap, switchmap);
        this.platform.log.info(`GET RotationSpeed for ${this.accessory.displayName}: StatusMap=${statusmap}, Speed=${currentSpeedPercent}%`);
        return currentSpeedPercent;
    }

    /**
     * Get the current Fan Active state (ON/OFF) from the device status.
     */
    async getONOFFState(): Promise<CharacteristicValue> {
        // Optional: uncomment below to force a status refresh before getting value
        // await this.platform.refreshStatus(this.platform, false);

        // Use a default statusmap of 0 if device status is not yet available
        const statusmap = this.deviceStatus.getStatusMap(this.accessory.context.device.id)?.statusmap ?? 0;

        // Determine Active state based on statusmap.
        // Simple check: If statusmap is anything other than 0, assume the fan is active (ON or running at some speed).
        // Adjust this logic if the API returns a specific value (like BASE_FAN_SPEED) for an OFF state even when powered.
        const isActive = statusmap !== 0;
        const homekitState = isActive ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE;

        this.platform.log.info(`GET Active state for ${this.accessory.displayName}: StatusMap=${statusmap}, IsActive=${isActive}`);
        return homekitState;
    }


    // --- SET Handlers ---

    /**
     * Handle requests to set the fan speed from HomeKit (RotationSpeed Characteristic).
     * Calls the `setFanSpeed` API helper method via setdimctl endpoint for speeds > 0.
     * Setting speed to 0 is ignored here (handled by Active characteristic).
     */
    async setSpeed(value: CharacteristicValue): Promise<void> { // Return Promise<void> for async onSet
        const speedPercent = value as number;
        this.platform.log.info(`SET RotationSpeed request for ${this.accessory.displayName} to ${speedPercent}%`);

        // If speed is set to 0%, HomeKit should set Active to INACTIVE.
        // We avoid calling the speed API for 0%. OFF command is handled by setONOFFState.
        if (speedPercent <= 0) {
            this.platform.log.warn(`RotationSpeed set to ${speedPercent}%. Fan OFF is handled by setting Active=INACTIVE. Ignoring setSpeed API call.`);
            // Ensure Active characteristic reflects OFF locally, without triggering setONOFFState
            this.service?.updateCharacteristic(this.platform.Characteristic.Active, this.platform.Characteristic.Active.INACTIVE);
            return; // Exit early - we return void, no callback needed for Homebridge with async/await
        }

        // If speed is > 0, ensure fan is marked as Active locally
         this.service?.updateCharacteristic(this.platform.Characteristic.Active, this.platform.Characteristic.Active.ACTIVE);

        try {
            // Call the API helper method specifically for setting speed via setdimctl
            await this.platform.apiHelper.setFanSpeed(
                this.accessory.context.device.id,
                this.accessory.context.device.ip,
                speedPercent,
                (response) => { // API Callback (primarily for logging here)
                    if (response && response.result === 'success') {
                        this.platform.log.info(`API call to set fan speed for ${this.accessory.displayName} to ${speedPercent}% successful.`);
                    } else {
                        // Error logged within setFanSpeed helper, log additional context here if needed
                        this.platform.log.error(`API call failed to set fan speed for ${this.accessory.displayName}. Reason: ${response?.reason || 'Unknown'}`);
                    }
                }
            );
             // If await completes without error, Homebridge assumes success
             this.platform.log.debug(`setFanSpeed promise resolved for ${this.accessory.displayName}`);

        } catch (error) {
             // Log the error caught from the awaited promise
             const errorMessage = error instanceof Error ? error.message : String(error);
             this.platform.log.error(`Error setting fan speed for ${this.accessory.displayName}: ${errorMessage}`);
             // Rethrow error to signal failure to HomeKit
             throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }

    /**
     * Handle requests to turn the fan ON or OFF from HomeKit (Active Characteristic).
     * Calls the `setSwitchStatus` API helper method, which internally selects
     * the correct FAN_ON/FAN_OFF payloads based on the intent.
     */
    async setONOFFState(value: CharacteristicValue): Promise<void> { // Return Promise<void> for async onSet
        const targetStateHK = value as number;
        const targetState = targetStateHK === this.platform.Characteristic.Active.ACTIVE ? 'ON' : 'OFF';
        this.platform.log.info(`SET Active request for ${this.accessory.displayName} to ${targetState}`);

        // Determine the 'input statusmap' needed by setSwitchStatus helper to trigger correct fan payload logic.
        // Use 1 for ON intent, 0 for OFF intent. The helper ignores this value for fans and uses its internal ON/OFF payloads.
        const inputStatusmapForHelper = targetState === 'ON' ? 1 : 0;

        // Get the switchmap identifying this specific fan switch on the device
        const switchmap = SmarteefiHelper.getSwitchMap(this.accessory.context.device.sequence);

        try {
            // Call the standard setSwitchStatus, ensuring isFan=true is passed
            await this.platform.apiHelper.setSwitchStatus(
                this.accessory.context.device.id,
                this.accessory.context.device.ip,
                switchmap,                  // Identifies *which* switch IS the fan
                inputStatusmapForHelper,    // Signals ON or OFF *intent* to the helper
                true,                       // Explicitly state this IS a fan device
                (response) => { // API Callback (primarily for logging)
                    if (response && response.result === 'success') {
                        this.platform.log.info(`API call to set fan ${targetState} for ${this.accessory.displayName} successful.`);

                        // If turning OFF, also update RotationSpeed characteristic to 0 locally
                        if (targetState === 'OFF') {
                             this.service?.updateCharacteristic(this.platform.Characteristic.RotationSpeed, 0);
                             this.platform.log.debug(`Updated RotationSpeed to 0 locally for ${this.accessory.displayName} as fan turned OFF.`);
                        }
                    } else {
                        this.platform.log.error(`API call failed to set fan ${targetState} for ${this.accessory.displayName}. Reason: ${response?.reason || 'Unknown'}`);
                    }
                }
            );
            // If await completes without error, Homebridge assumes success
            this.platform.log.debug(`setSwitchStatus promise resolved for ${this.accessory.displayName}`);

        } catch (error) {
            // Log the error caught from the awaited promise
             const errorMessage = error instanceof Error ? error.message : String(error);
             this.platform.log.error(`Error setting fan ${targetState} for ${this.accessory.displayName}: ${errorMessage}`);
             // Rethrow error to signal failure to HomeKit
             throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }
}