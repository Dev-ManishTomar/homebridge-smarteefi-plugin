import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { SmarteefiPlatform } from '../../platform';
// Import Config only if needed for the apiHelper instantiation type
// If apiHelper is taken from platform, Config might not be needed here.
import { Config, DeviceStatus } from '../Config';
import { SmarteefiAPIHelper } from '../SmarteefiAPIHelper';
import * as SmarteefiHelper from '../SmarteefiHelper';
import { STRINGS } from '../../constants';
import { BaseAccessory } from './BaseAccessory';

export class SwitchAccessory extends BaseAccessory {

    // This seems unused and potentially incorrect logic for state tracking
    // private switchStates = {
    //     On: this.platform.Characteristic.Active.INACTIVE
    // };

    // It's generally better practice for accessories to use the shared API helper
    // instance from the platform instead of creating their own.
    // Remove this line if platform.apiHelper is available and used.
    // private apiHelper: SmarteefiAPIHelper; // Removed instance variable

    constructor(
        platform: SmarteefiPlatform,
        accessory: PlatformAccessory,
    ) {
        super(platform, accessory);

        // ** REMOVED: Don't create a separate API Helper instance here **
        // Use the one from the platform: this.platform.apiHelper
        // this.apiHelper = SmarteefiAPIHelper.Instance(new Config(platform.config.userid, platform.config.password, platform.config.devices, platform.config.local), platform.log);

        if (this.accessoryService) {
            this.accessoryService.setCharacteristic(this.platform.Characteristic.Model, STRINGS.SWITCH);
        }

        // Ensure Switch service exists or create it
        this.service = this.accessory.getService(this.platform.Service.Switch)
            || this.accessory.addService(this.platform.Service.Switch, this.accessory.displayName);

        // Register handlers for the On/Off Characteristic
        this.service.getCharacteristic(this.platform.Characteristic.On)
            .onSet(this.setOn.bind(this))
            .onGet(this.getOn.bind(this));
    }

    /**
     * Handle "SET" requests from HomeKit
     * These are sent when the user changes the state of an accessory characteristic
     */
    async setOn(value: CharacteristicValue): Promise<void> { // Use async/await and return Promise<void>
        const targetState = value as boolean; // On characteristic uses boolean true/false
        this.platform.log.info(`SET On request for ${this.accessory.displayName} to ${targetState}`);

        // Use the shared API helper from the platform instance
        const apiHelper = this.platform.apiHelper;
        if (!apiHelper) {
            this.platform.log.error(`API Helper not available for ${this.accessory.displayName}. Cannot set state.`);
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }

        const switchmap = SmarteefiHelper.getSwitchMap(this.accessory.context.device.sequence);
        // For regular switches, statusmap directly represents the state (0=off, 1=on - usually matches switchmap bit)
        // If targetState is true (ON), set the corresponding bit in statusmap.
        // If targetState is false (OFF), clear the corresponding bit.
        // We send the bitmask representing *just this switch* for both switchmap and statusmap.
        const apiStatusmap = targetState ? switchmap : 0;

        try {
            await apiHelper.setSwitchStatus(
                this.accessory.context.device.id,
                this.accessory.context.device.ip,
                switchmap,      // Identifies the switch
                apiStatusmap,   // Represents the target state for this switch (0 or its own bit value)
                false,          // isFan = false for SwitchAccessory
                (response) => { // API Callback (primarily for logging)
                    if (response && response.result === 'success') {
                        this.platform.log.info(`API call to set ${this.accessory.displayName} to ${targetState ? 'ON' : 'OFF'} successful.`);
                        // ** FIX: Call refreshStatus correctly using setImmediate **
                        // Use an arrow function to preserve 'this' context for this.platform
                        setImmediate(() => {
                            this.platform.log.debug(`Scheduling immediate status refresh after setting ${this.accessory.displayName}`);
                            this.platform.refreshStatus(); // Call without arguments
                        });
                    } else {
                        this.platform.log.error(`API call failed to set ${this.accessory.displayName}: ${response?.reason || 'Unknown error'}`);
                        // Should we throw here inside callback? Better to throw after await below.
                    }
                }
            );
            // If await finishes without throwing, operation succeeded from HomeKit's perspective
             this.platform.log.debug(`setSwitchStatus promise resolved for ${this.accessory.displayName}`);

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.platform.log.error(`Error setting state for ${this.accessory.displayName}: ${errorMessage}`);
            // Rethrow HAP error to inform HomeKit of failure
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }

    /**
     * Handle "GET" requests from HomeKit
     * These are sent when HomeKit wants to know the current state of the accessory characteristic
     */
    async getOn(): Promise<CharacteristicValue> {
        // Use the shared device status cache from the platform
        const deviceStatus = this.platform['deviceStatus'] as DeviceStatus; // Access potentially private member if needed, or add getter
        if (!deviceStatus) {
             this.platform.log.error("DeviceStatus instance not found on platform.");
             throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }

        const deviceId = this.accessory.context.device.id;
        const sequence = this.accessory.context.device.sequence;

        // Get the latest known statusmap for the whole device
        const currentDeviceStatus = deviceStatus.getStatusMap(deviceId);
        const statusmap = currentDeviceStatus?.statusmap ?? 0; // Default to 0 if not found

        this.platform.log.debug(`GET On for ${this.accessory.displayName}: DeviceId=${deviceId}, Sequence=${sequence}, FullStatusMap=${statusmap}`);

        if (statusmap === -1) { // Check if status indicates a previous error
            this.platform.log.warn(`GET On for ${this.accessory.displayName}: Status is marked as errored (-1).`);
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }

        // Check if the specific bit for this switch is set in the statusmap
        const switchmapBit = SmarteefiHelper.getSwitchMap(sequence); // Get the bit for this switch
        const isOn = (statusmap & switchmapBit) !== 0;

        this.platform.log.info(`GET On for ${this.accessory.displayName}: State=${isOn}`);
        return isOn; // Return boolean true/false for On characteristic
    }
}