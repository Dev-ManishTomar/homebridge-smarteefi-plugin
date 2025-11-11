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

        // Initialize characteristics to avoid UI defaulting to 100%
        try {
            const deviceId = this.accessory.context.device.id;
            const status = this.deviceStatus.getStatusMap(deviceId);
            // Prefer cached speed if available; otherwise default to 0
            let initSpeedPercent = status?.speedValue ? SmarteefiHelper.valueToPercent(status.speedValue) : 0;
            if (initSpeedPercent < 0) initSpeedPercent = 0;
            if (initSpeedPercent > 100) initSpeedPercent = 100;
            const isFanOn = initSpeedPercent > 0;
            this.service.updateCharacteristic(this.platform.Characteristic.Active, isFanOn ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE);
            this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, initSpeedPercent);
            this.platform.log.debug(`Initialized ${this.accessory.displayName} Active=${isFanOn} RotationSpeed=${initSpeedPercent}%`);
        } catch { /* ignore init errors */ }
    }

    // --- GET Handlers ---
    async getSpeed(): Promise<CharacteristicValue> {
        const deviceId = this.accessory.context.device.id;
        const currentDeviceStatus = this.deviceStatus.getStatusMap(deviceId);
        const cachedSpeedValue = currentDeviceStatus?.speedValue ?? null;
        const speedPercent = (cachedSpeedValue !== null && cachedSpeedValue > 0)
            ? SmarteefiHelper.valueToPercent(cachedSpeedValue)
            : 0;
        // Clamp to [0,100]
        // (valueToPercent guarantees 0/25/50/75/100, but clamp defensively)
        // Note: speedPercent is const; clamp via computed value if needed
        const clamped = Math.max(0, Math.min(100, speedPercent));

        this.platform.log.info(`GET RotationSpeed for ${this.accessory.displayName}: Returning ${clamped}% (speedValue=${cachedSpeedValue})`);
        return clamped;
    }

    async getONOFFState(): Promise<CharacteristicValue> {
        const deviceId = this.accessory.context.device.id;
        const currentDeviceStatus = this.deviceStatus.getStatusMap(deviceId);
        const statusmap = currentDeviceStatus?.statusmap ?? 0;
        const sequence = this.accessory.context.device.sequence;
        const fanBit = SmarteefiHelper.getSwitchMap(sequence);

        this.platform.log.debug(`GET Active for ${this.accessory.displayName}: DeviceId=${deviceId}, StatusMap=${statusmap}`);
        
        if (statusmap === -1) {
            this.platform.log.warn(`GET Active for ${this.accessory.displayName}: Status is marked as errored (-1).`);
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }

        // Consider transient in-flight speed changes as ON to avoid flicker
        const transientOn = (currentDeviceStatus?.pendingUpdate === true) && ((statusmap & fanBit) !== 0);
        const cachedSpeedValue = currentDeviceStatus?.speedValue ?? null;
        const effectivePercent = (cachedSpeedValue && cachedSpeedValue > 0)
            ? SmarteefiHelper.valueToPercent(cachedSpeedValue)
            : 0;

        const isActive = (effectivePercent > 0 || transientOn)
            ? this.platform.Characteristic.Active.ACTIVE
            : this.platform.Characteristic.Active.INACTIVE;
        
        this.platform.log.info(`GET Active state for ${this.accessory.displayName}: Returning ${isActive === 0 ? 'INACTIVE' : 'ACTIVE'} (percent=${effectivePercent}, statusmap=${statusmap}, transientOn=${transientOn})`);
        return isActive;
    }

    // --- SET Handlers ---
    async setSpeed(value: CharacteristicValue): Promise<void> {
        const requestedSpeedPercent = value as number;
        this.platform.log.info(`SET RotationSpeed request for ${this.accessory.displayName} to ${requestedSpeedPercent}%`);

        if (requestedSpeedPercent <= 0) {
            this.platform.log.warn(`RotationSpeed set to ${requestedSpeedPercent}%. Triggering OFF state and setting speed to 0.`);
            // Ensure HK shows 0% immediately to avoid UI bouncing back
            this.service?.updateCharacteristic(this.platform.Characteristic.RotationSpeed, 0);
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
        const cached = this.deviceStatus.getStatusMap(deviceId);
        const sequence = this.accessory.context.device.sequence;
        const fanBit = SmarteefiHelper.getSwitchMap(sequence);
        const currentStatusmap = cached?.statusmap ?? 0;
        const currentSwitchmap = cached?.switchmap ?? 255;
        const newStatusmapOptimistic = currentStatusmap | fanBit; // set fan bit ON
        this.deviceStatus.setStatusMap(deviceId, currentSwitchmap, newStatusmapOptimistic, targetSpeedValue);
        // Update preserved speed only if fan was already ON or this is not the default 100% kick from Home
        const wasFanOn = (currentStatusmap & fanBit) !== 0;
        const preservedAtOff = this.deviceStatus.getPreservedAtOff(deviceId);
        if (wasFanOn) {
            this.deviceStatus.setPreservedSpeedValue(deviceId, targetSpeedValue);
        } else {
            // Fan was OFF before this setSpeed call
            if (requestedSpeedPercent === 100 && preservedAtOff !== null) {
                // Ignore default 100% that some UIs send on toggle
                this.platform.log.debug(`[PRESERVE] Ignoring 100% speed update while OFF; keeping preservedAtOff=${preservedAtOff}`);
            } else {
                // Treat as user's intended target while OFF: prime OFF snapshot
                this.deviceStatus.setPreservedAtOff(deviceId, targetSpeedValue);
            }
        }

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
                                // Do NOT change ON/OFF based on setdimctl response.status; only update speedValue
                                const cached2 = this.deviceStatus.getStatusMap(deviceId);
                                const currentStatusmap2 = cached2?.statusmap ?? 0;
                                const currentSwitchmap2 = cached2?.switchmap ?? 255;
                                this.platform.log.debug(`[API_CONFIRM] Updating cache speed only: keep statusmap=${currentStatusmap2}, speed=${apiReportedSpeedValue}`);
                                this.deviceStatus.setStatusMap(deviceId, currentSwitchmap2, currentStatusmap2, apiReportedSpeedValue);
                                    this.deviceStatus.setPreservedSpeedValue(deviceId, apiReportedSpeedValue);
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
        const fanBit = SmarteefiHelper.getSwitchMap(sequence);

        // OPTIMISTIC UPDATE PATTERN:
        // 1. Save current state for potential rollback
        this.deviceStatus.saveRollbackState(deviceId);
        this.deviceStatus.markCommandInProgress(deviceId);

        // 2. Calculate target state values
        const cachedStatus = this.deviceStatus.getStatusMap(deviceId);
        const currentStatusmap = cachedStatus?.statusmap ?? 0;
        const currentSwitchmap = cachedStatus?.switchmap ?? 255;
        const newStatusmap = targetState === 'ON' ? (currentStatusmap | fanBit) : (currentStatusmap & ~fanBit);
        const currentSpeed = cachedStatus?.speedValue ?? null;
        const preserved = this.deviceStatus.getPreservedSpeedValue(deviceId);
        let speedToStore: number | null;

        if (targetState === 'OFF') {
            // Preserve last non-zero speed separately; clear active speed for OFF state
            const toPreserve = (currentSpeed && currentSpeed > 0) ? currentSpeed : (preserved && preserved > 0 ? preserved : null);
            this.deviceStatus.setPreservedSpeedValue(deviceId, toPreserve ?? null);
            this.deviceStatus.setPreservedAtOff(deviceId, toPreserve ?? null);
            speedToStore = 0; // make current (active) speed zero while OFF
            this.platform.log.info(`[OFF] Preserving last speed: ${toPreserve} and clearing active speed to 0`);
        } else {
            // When turning ON, use preserved speed or default to 1 (25%)
            const preservedAtOffNow = this.deviceStatus.getPreservedAtOff(deviceId);
            const restore = (preservedAtOffNow && preservedAtOffNow > 0)
                ? preservedAtOffNow
                : ((preserved && preserved > 0) ? preserved : ((currentSpeed && currentSpeed > 0) ? currentSpeed : 1));
            // Do NOT set active speed yet; only remember intended restore target
            speedToStore = undefined as unknown as number; // sentinel to avoid writing speed now
            this.deviceStatus.setPreservedSpeedValue(deviceId, restore);
            this.deviceStatus.setPreservedAtOff(deviceId, null); // consume snapshot
            this.platform.log.info(`[ON] Restoring speed: ${restore} (${SmarteefiHelper.valueToPercent(restore)}%)`);
        }

        // 3. Update cache immediately (optimistic)
        if (targetState === 'ON') {
            this.platform.log.info(`[OPTIMISTIC] Updating cache for ${deviceId}: statusmap=${newStatusmap} (speed pending)`);
            // Do not change speedValue yet
            this.deviceStatus.setStatusMap(deviceId, currentSwitchmap, newStatusmap);
        } else {
            this.platform.log.info(`[OPTIMISTIC] Updating cache for ${deviceId}: statusmap=${newStatusmap}, speedValue=${0}`);
            this.deviceStatus.setStatusMap(deviceId, currentSwitchmap, newStatusmap, 0);
        }

        // 4. Update HomeKit characteristics immediately (instant UI update)
        this.service?.updateCharacteristic(this.platform.Characteristic.Active, targetStateHK);
        if (targetState === 'OFF') {
            // Ensure UI shows 0% on OFF
            this.service?.updateCharacteristic(this.platform.Characteristic.RotationSpeed, 0);
            this.platform.log.info(`[OPTIMISTIC] Updated RotationSpeed to 0% on OFF`);
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
                        // If turning ON, proactively set the preserved speed on the regulator
                        if (targetState === 'ON') {
                            const restoreVal = this.deviceStatus.getPreservedSpeedValue(deviceId);
                            const desiredPercent = restoreVal && restoreVal > 0 ? SmarteefiHelper.valueToPercent(restoreVal) : 25;
                            this.platform.log.info(`[FOLLOW-UP] Setting preserved fan speed to ${desiredPercent}% after ON for ${this.accessory.displayName}`);
                            // Fire-and-forget; we already optimistically updated cache/UI
                            apiHelper.setFanSpeed(deviceId, deviceIp, desiredPercent, (_rsp) => {
                                // Optionally reconcile cache with API response value
                                if (_rsp && _rsp.result === 'success' && _rsp.value !== undefined) {
                                    const cached3 = this.deviceStatus.getStatusMap(deviceId);
                                    const currentStatusmap3 = cached3?.statusmap ?? 0;
                                    const currentSwitchmap3 = cached3?.switchmap ?? 255;
                                    // Now apply active speed in cache and update HK RotationSpeed
                                    this.deviceStatus.setStatusMap(deviceId, currentSwitchmap3, currentStatusmap3, _rsp.value);
                                    this.deviceStatus.setPreservedSpeedValue(deviceId, _rsp.value);
                                    this.platform.log.debug(`[FOLLOW-UP] Confirmed preserved speed applied: value=${_rsp.value}`);
                                    const appliedPercent = SmarteefiHelper.valueToPercent(_rsp.value);
                                    this.service?.updateCharacteristic(this.platform.Characteristic.RotationSpeed, appliedPercent);
                                    this.platform.log.info(`[APPLIED] Updated RotationSpeed to ${appliedPercent}% after ON`);
                                }
                            });
                        }
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