// src/lib/accessories/FanAccessory.ts

import { Service, PlatformAccessory, CharacteristicValue, Characteristic } from 'homebridge'; // Added NumericCharacteristic for type check
import { SmarteefiPlatform } from '../../platform';
import * as SmarteefiHelper from '../SmarteefiHelper';
import { STRINGS } from '../../constants';
import { BaseAccessory } from './BaseAccessory';

// Assume SmarteefiHelper.valueToPercent exists

export class FanAccessory extends BaseAccessory {
    private speedDebounceTimer: NodeJS.Timeout | null = null;

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
        
        // Configure RotationSpeed characteristic with discrete steps FIRST
        const rotationSpeedChar = this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed);
        rotationSpeedChar.setProps({
            minStep: 25,  // Makes slider snap to discrete levels: 0%, 25%, 50%, 75%, 100%
            minValue: 0,
            maxValue: 100,
            validValueRanges: [0, 100], // Explicitly set valid range
        });
        this.platform.log.info(`✓ Configured ${this.accessory.displayName} with discrete speed steps: 0%, 25%, 50%, 75%, 100%`);

        // Register Handlers AFTER props are set
        this.service.getCharacteristic(this.platform.Characteristic.Active)
            .onGet(this.getONOFFState.bind(this))
            .onSet(this.setONOFFState.bind(this));
        rotationSpeedChar
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
        const speedValue = currentDeviceStatus?.speedValue ?? null;
        
        this.platform.log.debug(`GET Active for ${this.accessory.displayName}: DeviceId=${deviceId}, StatusMap=${statusmap}, SpeedValue=${speedValue}`);
        
        if (statusmap === -1) {
            this.platform.log.warn(`GET Active for ${this.accessory.displayName}: Status is marked as errored (-1).`);
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        
        // For fans, check BOTH statusmap AND speedValue
        // Fan is ON only if speedValue > 0, regardless of statusmap
        // statusmap might show other switches ON, but fan itself uses speedValue
        let isActive: number;
        if (speedValue !== null && speedValue > 0) {
            isActive = this.platform.Characteristic.Active.ACTIVE;
        } else if (statusmap === 0) {
            isActive = this.platform.Characteristic.Active.INACTIVE;
        } else {
            // statusmap > 0 but speedValue is 0/null = Fan is OFF (other switches might be ON)
            isActive = this.platform.Characteristic.Active.INACTIVE;
        }
        
        this.platform.log.info(`GET Active state for ${this.accessory.displayName}: Returning ${isActive === 0 ? 'INACTIVE' : 'ACTIVE'} (statusmap=${statusmap}, speed=${speedValue})`);
        return isActive;
    }

    // --- SET Handlers ---
    async setSpeed(value: CharacteristicValue): Promise<void> {
        const requestedSpeedPercent = value as number;
        this.platform.log.info(`SET RotationSpeed request for ${this.accessory.displayName} to ${requestedSpeedPercent}%`);

        if (requestedSpeedPercent <= 0) {
            this.platform.log.warn(`RotationSpeed set to ${requestedSpeedPercent}%. Triggering OFF state.`);
            return await this.setONOFFState(this.platform.Characteristic.Active.INACTIVE);
        }

        const deviceId = this.accessory.context.device.id;
        const apiHelper = this.platform.apiHelper;
        
        if (!apiHelper || !this.accessory.context?.device) {
            this.platform.log.error(`API Helper or device context not available for ${this.accessory.displayName}`);
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }

        const deviceIp = this.accessory.context.device.ip;

        // Convert percentage to API value (1-4) for cache
        let targetSpeedValue: number;
        if (requestedSpeedPercent <= 25) {
            targetSpeedValue = 1;
        } else if (requestedSpeedPercent <= 50) {
            targetSpeedValue = 2;
        } else if (requestedSpeedPercent <= 75) {
            targetSpeedValue = 3;
        } else {
            targetSpeedValue = 4;
        }

        // OPTIMISTIC UPDATE PATTERN:
        // 1. Save current state for rollback
        this.deviceStatus.saveRollbackState(deviceId);
        this.deviceStatus.markCommandInProgress(deviceId);

        // 2. Update cache immediately (optimistic)
        this.platform.log.info(`[OPTIMISTIC] Updating cache for ${deviceId}: speed=${targetSpeedValue} (${requestedSpeedPercent}%)`);
        this.deviceStatus.setStatusMap(deviceId, 112, 112, targetSpeedValue); // statusmap=112 means ON

        // 3. Update HomeKit characteristics immediately (instant UI update)
        this.service?.updateCharacteristic(this.platform.Characteristic.RotationSpeed, requestedSpeedPercent);
        this.service?.updateCharacteristic(this.platform.Characteristic.Active, this.platform.Characteristic.Active.ACTIVE);
        this.platform.log.info(`[OPTIMISTIC] Updated HomeKit: Active=ON, Speed=${requestedSpeedPercent}%`);

        // 4. Debounce API call (prevent flooding when user drags slider)
        if (this.speedDebounceTimer) {
            clearTimeout(this.speedDebounceTimer);
        }

        this.speedDebounceTimer = setTimeout(async () => {
            try {
                await apiHelper.setFanSpeed(
                    deviceId, deviceIp, requestedSpeedPercent,
                    (response) => {
                        this.deviceStatus.markCommandComplete(deviceId);
                        
                        if (response && response.result === 'success') {
                            // 5. API Success - confirm with API values if available
                            this.platform.log.info(`✓ API confirmed fan speed for ${this.accessory.displayName}`);
                            
                            if (response.status !== undefined && response.value !== undefined) {
                                const apiReportedSpeedValue = response.value;
                                const apiReportedOnState = response.status === 1;
                                const newStatusmap = apiReportedOnState ? 112 : 0;
                                
                                this.platform.log.debug(`[API_CONFIRM] Updating cache with API values: statusmap=${newStatusmap}, speed=${apiReportedSpeedValue}`);
                                this.deviceStatus.setStatusMap(deviceId, 112, newStatusmap, apiReportedSpeedValue);
                            }
                        } else {
                            // 6. API Failure - rollback state
                            this.platform.log.warn(`✗ API failed to set fan speed for ${this.accessory.displayName}: ${response?.reason || 'Unknown error'}`);
                            
                            if (this.deviceStatus.rollbackState(deviceId)) {
                                this.platform.log.info(`[ROLLBACK] Reverted speed for ${deviceId}`);
                                
                                // Rollback HomeKit characteristics
                                const rolledBackStatus = this.deviceStatus.getStatusMap(deviceId);
                                if (rolledBackStatus) {
                                    const rolledBackSpeed = rolledBackStatus.speedValue ? 
                                        SmarteefiHelper.valueToPercent(rolledBackStatus.speedValue) : 0;
                                    this.service?.updateCharacteristic(this.platform.Characteristic.RotationSpeed, rolledBackSpeed);
                                    
                                    const rolledBackActive = rolledBackStatus.statusmap === 0 ? 
                                        this.platform.Characteristic.Active.INACTIVE : 
                                        this.platform.Characteristic.Active.ACTIVE;
                                    this.service?.updateCharacteristic(this.platform.Characteristic.Active, rolledBackActive);
                                }
                            }
                        }
                    }
                );
            } catch (error) {
                this.deviceStatus.markCommandComplete(deviceId);
                const errorMessage = error instanceof Error ? error.message : String(error);
                this.platform.log.warn(`Exception setting fan speed for ${this.accessory.displayName}: ${errorMessage}`);
                
                // Rollback on exception
                if (this.deviceStatus.rollbackState(deviceId)) {
                    this.platform.log.info(`[ROLLBACK] Reverted speed after exception for ${deviceId}`);
                    const rolledBackStatus = this.deviceStatus.getStatusMap(deviceId);
                    if (rolledBackStatus) {
                        const rolledBackSpeed = rolledBackStatus.speedValue ? 
                            SmarteefiHelper.valueToPercent(rolledBackStatus.speedValue) : 0;
                        this.service?.updateCharacteristic(this.platform.Characteristic.RotationSpeed, rolledBackSpeed);
                    }
                }
                // Don't throw - optimistic update already happened
            }
        }, 300); // 300ms debounce delay
    }

    async setONOFFState(value: CharacteristicValue): Promise<void> {
        const targetStateHK = value as number; // Active characteristic value is number (0 or 1)
        const targetState = targetStateHK === this.platform.Characteristic.Active.ACTIVE ? 'ON' : 'OFF';

        const deviceId = this.accessory.context.device.id;
        this.platform.log.info(`SET Active request for ${this.accessory.displayName} to ${targetState}`);

        const apiHelper = this.platform.apiHelper;
        if (!apiHelper || !this.accessory.context?.device) { 
            this.platform.log.error('API Helper or context missing');
            throw new Error("API Helper or context missing"); 
        }

        const deviceIp = this.accessory.context.device.ip;
        const sequence = this.accessory.context.device.sequence;

        // OPTIMISTIC UPDATE PATTERN:
        // 1. Save current state for potential rollback
        this.deviceStatus.saveRollbackState(deviceId);
        this.deviceStatus.markCommandInProgress(deviceId);

        // 2. Calculate target state values
        const newStatusmap = targetState === 'ON' ? 112 : 0;
        const cachedStatus = this.deviceStatus.getStatusMap(deviceId);
        const currentSpeed = cachedStatus?.speedValue ?? null;
        let speedToStore: number | null;

        if (targetState === 'OFF') {
            // PRESERVE speed when turning OFF (don't clear it)
            // This allows us to restore the same speed when turning back ON
            speedToStore = currentSpeed; // Keep the last known speed
            this.platform.log.info(`[OFF] Preserving last speed: ${speedToStore} for next ON`);
        } else {
            // When turning ON, use preserved speed or default to 1 (25%)
            speedToStore = (currentSpeed && currentSpeed > 0) ? currentSpeed : 1;
            this.platform.log.info(`[ON] Restoring speed: ${speedToStore} (${SmarteefiHelper.valueToPercent(speedToStore)}%)`);
        }

        // 3. Update cache immediately (optimistic)
        this.platform.log.info(`[OPTIMISTIC] Updating cache for ${deviceId}: statusmap=${newStatusmap}, speedValue=${speedToStore}`);
        this.deviceStatus.setStatusMap(deviceId, 112, newStatusmap, speedToStore);

        // 4. Update HomeKit characteristics immediately (instant UI update)
        this.service?.updateCharacteristic(this.platform.Characteristic.Active, targetStateHK);
        if (targetState === 'ON' && speedToStore) {
            const speedPercent = SmarteefiHelper.valueToPercent(speedToStore);
            this.service?.updateCharacteristic(this.platform.Characteristic.RotationSpeed, speedPercent);
            this.platform.log.info(`[OPTIMISTIC] Updated RotationSpeed to ${speedPercent}%`);
        }

        // 5. Call API in background
        const inputStatusmapForHelper = targetState === 'ON' ? 1 : 0;
        const switchmap = SmarteefiHelper.getSwitchMap(sequence);

        try {
            await apiHelper.setSwitchStatus(
                deviceId, deviceIp, switchmap, inputStatusmapForHelper, true,
                (response) => {
                    this.deviceStatus.markCommandComplete(deviceId);
                    
                    if (response && response.result === 'success') {
                        // 6. API Success - keep optimistic state
                        this.platform.log.info(`✓ API confirmed fan ${targetState} for ${this.accessory.displayName}`);
                    } else {
                        // 7. API Failure - rollback state
                        this.platform.log.warn(`✗ API failed to set fan ${targetState} for ${this.accessory.displayName}: ${response?.reason || 'Unknown error'}`);
                        
                        if (this.deviceStatus.rollbackState(deviceId)) {
                            this.platform.log.info(`[ROLLBACK] Reverted state for ${deviceId}`);
                            
                            // Rollback HomeKit characteristics
                            const rolledBackStatus = this.deviceStatus.getStatusMap(deviceId);
                            if (rolledBackStatus) {
                                const rolledBackActive = rolledBackStatus.statusmap === 0 ? 
                                    this.platform.Characteristic.Active.INACTIVE : 
                                    this.platform.Characteristic.Active.ACTIVE;
                                this.service?.updateCharacteristic(this.platform.Characteristic.Active, rolledBackActive);
                                
                                if (rolledBackStatus.speedValue) {
                                    const rolledBackSpeed = SmarteefiHelper.valueToPercent(rolledBackStatus.speedValue);
                                    this.service?.updateCharacteristic(this.platform.Characteristic.RotationSpeed, rolledBackSpeed);
                                }
                            }
                        }
                    }
                }
            );
        } catch (error) {
            this.deviceStatus.markCommandComplete(deviceId);
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.platform.log.warn(`Exception setting fan ${targetState} for ${this.accessory.displayName}: ${errorMessage}`);
            
            // Rollback on exception
            if (this.deviceStatus.rollbackState(deviceId)) {
                this.platform.log.info(`[ROLLBACK] Reverted state after exception for ${deviceId}`);
                const rolledBackStatus = this.deviceStatus.getStatusMap(deviceId);
                if (rolledBackStatus) {
                    const rolledBackActive = rolledBackStatus.statusmap === 0 ? 
                        this.platform.Characteristic.Active.INACTIVE : 
                        this.platform.Characteristic.Active.ACTIVE;
                    this.service?.updateCharacteristic(this.platform.Characteristic.Active, rolledBackActive);
                }
            }
            // Don't throw - optimistic update already happened
        }
    }
} // End Class FanAccessory