/* Copyright(C) 2022-2024, donavanbecker (https://github.com/donavanbecker). All rights reserved.
 *
 * thermostats.ts: homebridge-resideo.
 */
import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge'

import type { ResideoPlatform } from '../platform.js'
import type { devicesConfig, fanStatus, location, payload, resideoDevice, roomPriorityStatus } from '../settings.js'

// import { request } from 'undici';
import { interval, Subject } from 'rxjs'
import { debounceTime, skipWhile, take, tap } from 'rxjs/operators'

import { DeviceURL } from '../settings.js'
import { HomeKitModes, ResideoModes, toCelsius, toFahrenheit } from '../utils.js'
import { deviceBase } from './device.js'

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class Thermostats extends deviceBase {
  // Services
  private Thermostat: {
    Name: CharacteristicValue
    Service: Service
    TargetTemperature: CharacteristicValue
    CurrentTemperature: CharacteristicValue
    TemperatureDisplayUnits: CharacteristicValue
    TargetHeatingCoolingState: CharacteristicValue
    CurrentHeatingCoolingState: CharacteristicValue
    CoolingThresholdTemperature: CharacteristicValue
    HeatingThresholdTemperature: CharacteristicValue
  }

  private Fan?: {
    Name: CharacteristicValue
    Service: Service
    Active: CharacteristicValue
    TargetFanState: CharacteristicValue
  }

  private HumiditySensor?: {
    Name: CharacteristicValue
    Service: Service
    CurrentRelativeHumidity: CharacteristicValue
  }

  private StatefulProgrammableSwitch?: {
    Name: CharacteristicValue
    Service: Service
    ProgrammableSwitchEvent: CharacteristicValue
    ProgrammableSwitchOutputState: CharacteristicValue
  }

  // Config
  thermostatSetpointStatus!: string

  // Thermostat Updates
  thermostatUpdateInProgress!: boolean
  doThermostatUpdate!: Subject<void>

  // Fan Updates
  fanStatus!: fanStatus
  fanUpdateInProgress!: boolean
  doFanUpdate!: Subject<void>

  // Room Updates - T9 Only
  roomPriorityStatus!: roomPriorityStatus
  roomUpdateInProgress!: boolean
  doRoomUpdate!: Subject<void>

  constructor(
    readonly platform: ResideoPlatform,
    accessory: PlatformAccessory,
    location: location,
    device: resideoDevice & devicesConfig,
  ) {
    super(platform, accessory, location, device)

    this.getThermostatConfigSettings(accessory, device)

    // this is subject we use to track when we need to POST Room Priority changes to the Resideo API for Room Changes - T9 Only
    this.doRoomUpdate = new Subject()
    this.roomUpdateInProgress = false
    // this is subject we use to track when we need to POST Thermostat changes to the Resideo API
    this.doThermostatUpdate = new Subject()
    this.thermostatUpdateInProgress = false
    // this is subject we use to track when we need to POST Fan changes to the Resideo API
    this.doFanUpdate = new Subject()
    this.fanUpdateInProgress = false

    // Initialize Thermostat Service
    accessory.context.Thermostat = accessory.context.Thermostat ?? {}
    this.Thermostat = {
      Name: accessory.context.Thermostat.Name ?? accessory.displayName,
      Service: accessory.getService(this.hap.Service.Thermostat) ?? this.accessory.addService(this.hap.Service.Thermostat) as Service,
      TargetTemperature: accessory.context.TargetTemperature ?? 20,
      CurrentTemperature: accessory.context.CurrentTemperature ?? 20,
      TemperatureDisplayUnits: accessory.context.TemperatureDisplayUnits,
      TargetHeatingCoolingState: accessory.context.TargetHeatingCoolingState ?? this.hap.Characteristic.TargetHeatingCoolingState.AUTO,
      CurrentHeatingCoolingState: accessory.context.CurrentHeatingCoolingState ?? this.hap.Characteristic.CurrentHeatingCoolingState.OFF,
      CoolingThresholdTemperature: accessory.context.CoolingThresholdTemperature ?? 20,
      HeatingThresholdTemperature: accessory.context.HeatingThresholdTemperature ?? 22,
    }
    accessory.context.Thermostat = this.Thermostat as object

    // Service Name
    this.Thermostat.Service
      .setCharacteristic(this.hap.Characteristic.Name, this.Thermostat.Name)
      .setCharacteristic(this.hap.Characteristic.CurrentHeatingCoolingState, this.Thermostat.CurrentHeatingCoolingState)
      .getCharacteristic(this.hap.Characteristic.TemperatureDisplayUnits)
      .onGet(() => {
        this.Thermostat.TemperatureDisplayUnits = device.units === 'Celsius'
          ? this.hap.Characteristic.TemperatureDisplayUnits.CELSIUS
          : this.hap.Characteristic.TemperatureDisplayUnits.FAHRENHEIT
        accessory.context.TemperatureDisplayUnits = this.Thermostat.TemperatureDisplayUnits
        this.debugLog(`${this.device.deviceClass} ${accessory.displayName} TemperatureDisplayUnits: ${this.Thermostat.TemperatureDisplayUnits}`)
        return this.Thermostat.TemperatureDisplayUnits
      })
      .onSet(this.setTemperatureDisplayUnits.bind(this))

    // Set Min and Max
    if (device.minHeatSetpoint && device.maxHeatSetpoint) {
      this.debugLog(`${this.device.deviceClass} ${accessory.displayName} minHeatSetpoint: ${device.minHeatSetpoint}, maxHeatSetpoint: ${device.maxHeatSetpoint}, TemperatureDisplayUnits: ${this.Thermostat.TemperatureDisplayUnits}`)
      const minValue = toCelsius(device.minHeatSetpoint, Number(this.Thermostat.TemperatureDisplayUnits))
      const maxValue = toCelsius(device.maxHeatSetpoint, Number(this.Thermostat.TemperatureDisplayUnits))
      this.debugLog(`${this.device.deviceClass} ${accessory.displayName} minValue: ${minValue}, maxValue: ${maxValue}`)
      if (device.changeableValues!.heatCoolMode === 'Heat') {
        this.debugLog(`${device.deviceClass} ${accessory.displayName} is in "${device.changeableValues?.heatCoolMode}" mode`)
        this.Thermostat.Service
          .getCharacteristic(this.hap.Characteristic.TargetTemperature)
          .setProps({
            minValue,
            maxValue,
            minStep: 0.1,
          })
          .onGet(() => {
            return this.Thermostat.TargetTemperature
          })
        this.debugWarnLog(`${device.deviceClass} ${accessory.displayName} (HEAT) Min Heat Setpoint: ${device.minHeatSetpoint}. Max Heat Setpoint: ${device.maxHeatSetpoint} TemperatureDisplayUnits: ${this.Thermostat.TemperatureDisplayUnits}`)
      } else {
        this.debugLog(`${device.deviceClass} ${accessory.displayName} is in "${device.changeableValues?.heatCoolMode}" mode`)
        this.Thermostat.Service
          .getCharacteristic(this.hap.Characteristic.TargetTemperature)
          .setProps({
            minValue,
            maxValue,
            minStep: 0.1,
          })
          .onGet(() => {
            return this.Thermostat.TargetTemperature
          })
        this.debugWarnLog(`${device.deviceClass} ${accessory.displayName} (NOT HEAT) Min Heat Setpoint: ${device.minHeatSetpoint}. Max Heat Setpoint: ${device.maxHeatSetpoint} TemperatureDisplayUnits: ${this.Thermostat.TemperatureDisplayUnits}`)
      }
    }

    // The value property of TargetHeaterCoolerState must be one of the following:
    // AUTO = 3; HEAT = 1; COOL = 2; OFF = 0;
    // Set control bindings
    const TargetState = [4]
    TargetState.pop()
    if (this.device.allowedModes?.includes('Cool')) {
      TargetState.push(this.hap.Characteristic.TargetHeatingCoolingState.COOL)
    }
    if (this.device.allowedModes?.includes('Heat')) {
      TargetState.push(this.hap.Characteristic.TargetHeatingCoolingState.HEAT)
    }
    if (this.device.allowedModes?.includes('Off')) {
      TargetState.push(this.hap.Characteristic.TargetHeatingCoolingState.OFF)
    }
    if (this.device.allowedModes?.includes('Auto') || this.device.thermostat?.show_auto) {
      TargetState.push(this.hap.Characteristic.TargetHeatingCoolingState.AUTO)
    }
    this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} allowedModes: ${this.device.allowedModes}`)
    this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} Only Show These Modes: ${JSON.stringify(TargetState)}`)

    this.Thermostat.Service
      .getCharacteristic(this.hap.Characteristic.TargetHeatingCoolingState)
      .setProps({
        validValues: TargetState,
      })
      .onGet(() => {
        return this.Thermostat.TargetHeatingCoolingState
      })
      .onSet(this.setTargetHeatingCoolingState.bind(this))

    this.Thermostat.Service
      .getCharacteristic(this.hap.Characteristic.HeatingThresholdTemperature)
      .onGet(() => {
        return this.Thermostat.HeatingThresholdTemperature
      })
      .onSet(this.setHeatingThresholdTemperature.bind(this))

    this.Thermostat.Service
      .getCharacteristic(this.hap.Characteristic.CoolingThresholdTemperature)
      .onGet(() => {
        return this.Thermostat.CoolingThresholdTemperature
      })
      .onSet(this.setCoolingThresholdTemperature.bind(this))

    this.Thermostat.Service
      .getCharacteristic(this.hap.Characteristic.TargetTemperature)
      .onGet(() => {
        return this.Thermostat.TargetTemperature
      })
      .onSet(this.setTargetTemperature.bind(this))

    // Initialize Fan Service
    if (device.thermostat?.hide_fan) {
      if (this.Fan) {
        this.debugLog(`${this.device.deviceType}: ${accessory.displayName} Removing Fan Service`)
        this.Fan.Service = accessory.getService(this.hap.Service.Fanv2) as Service
        accessory.removeService(this.Fan.Service)
      } else {
        this.debugLog(`${this.device.deviceType}: ${accessory.displayName} Fan Service Not Found`)
      }
    } else if (device.settings?.fan) {
      this.debugLog(`${device.deviceClass} ${accessory.displayName} Available Fan Settings ${JSON.stringify(device.settings.fan)}`)
      accessory.context.Fan = accessory.context.Fan ?? {}
      this.Fan = {
        Name: accessory.context.Fan.Name ?? `${accessory.displayName} Fan`,
        Service: accessory.getService(this.hap.Service.Fanv2) ?? accessory.addService(this.hap.Service.Fanv2) as Service,
        Active: accessory.context.Active ?? this.hap.Characteristic.Active.ACTIVE,
        TargetFanState: accessory.context.TargetFanState ?? this.hap.Characteristic.TargetFanState.MANUAL,
      }
      accessory.context.Fan = this.Fan as object

      // Initialize Fan Characteristic
      this.Fan.Service
        .setCharacteristic(this.hap.Characteristic.Name, this.Fan.Name)
        .getCharacteristic(this.hap.Characteristic.Active)
        .onGet(() => {
          return this.Fan!.Active
        })
        .onSet(this.setActive.bind(this))

      this.Fan.Service
        .getCharacteristic(this.hap.Characteristic.TargetFanState)
        .onGet(() => {
          return this.Fan!.TargetFanState
        })
        .onSet(this.setTargetFanState.bind(this))
    } else {
      this.debugLog(`${device.deviceClass} ${accessory.displayName} Fanv2 Service Not Added`)
    }

    // Initialize Humidity Sensor Service
    if (device.thermostat?.hide_humidity) {
      if (this.HumiditySensor) {
        this.debugLog(`${this.device.deviceType}: ${accessory.displayName} Removing Humidity Sensor Service`)
        this.HumiditySensor.Service = this.accessory.getService(this.hap.Service.HumiditySensor) as Service
        accessory.removeService(this.HumiditySensor.Service)
      } else {
        this.debugLog(`${this.device.deviceType}: ${accessory.displayName} Humidity Sensor Service Not Found`)
      }
    } else if (device.indoorHumidity) {
      this.debugLog(`${device.deviceClass} ${accessory.displayName} Add Humidity Sensor Service`)
      accessory.context.HumiditySensor = accessory.context.HumiditySensor ?? {}
      this.HumiditySensor = {
        Name: accessory.context.HumiditySensor.Name ?? `${accessory.displayName} Humidity Sensor`,
        Service: accessory.getService(this.hap.Service.HumiditySensor) ?? accessory.addService(this.hap.Service.HumiditySensor) as Service,
        CurrentRelativeHumidity: accessory.context.CurrentRelativeHumidity ?? 50,
      }
      accessory.context.HumiditySensor = this.HumiditySensor as object

      // Initialize Humidity Sensor Characteristic
      this.HumiditySensor.Service
        .setCharacteristic(this.hap.Characteristic.Name, this.HumiditySensor.Name)

      this.HumiditySensor.Service
        .getCharacteristic(this.hap.Characteristic.CurrentRelativeHumidity)
        .setProps({
          minStep: 0.1,
        })
        .onGet(() => {
          return this.HumiditySensor!.CurrentRelativeHumidity
        })
    } else {
      this.debugLog(`${device.deviceClass} ${accessory.displayName} Humidity Sensor Service Not Added`)
    }

    // Initialize StatefulProgrammableSwitch property
    accessory.context.StatefulProgrammableSwitch = accessory.context.StatefulProgrammableSwitch ?? {}
    this.StatefulProgrammableSwitch = {
      Name: accessory.context.StatefulProgrammableSwitch.Name ?? accessory.displayName,
      Service: accessory.getService(this.hap.Service.StatefulProgrammableSwitch) ?? accessory.addService(this.hap.Service.StatefulProgrammableSwitch) as Service,
      ProgrammableSwitchEvent: accessory.context.ProgrammableSwitchEvent ?? this.hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
      ProgrammableSwitchOutputState: accessory.context.ProgrammableSwitchOutputState ?? 0,
    }
    accessory.context.StatefulProgrammableSwitch = this.StatefulProgrammableSwitch as object

    this.StatefulProgrammableSwitch.Service
      .setCharacteristic(this.hap.Characteristic.Name, this.StatefulProgrammableSwitch.Name)
      .getCharacteristic(this.hap.Characteristic.ProgrammableSwitchEvent)
      .setProps({
        validValues: [this.hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS],
      })
      .onGet(() => {
        return this.StatefulProgrammableSwitch!.ProgrammableSwitchEvent
      })

    this.StatefulProgrammableSwitch.Service
      .getCharacteristic(this.hap.Characteristic.ProgrammableSwitchOutputState)
      .onGet(() => {
        return this.StatefulProgrammableSwitch!.ProgrammableSwitchOutputState
      })
      .onSet(this.handleProgrammableSwitchOutputStateSet.bind(this))

    // Intial Refresh
    this.refreshStatus()

    // Start an update interval
    interval(this.deviceRefreshRate * 1000)
      .pipe(skipWhile(() => this.thermostatUpdateInProgress))
      .subscribe(async () => {
        await this.refreshStatus()
      })

    // Watch for thermostat change events
    // We put in a debounce of 100ms so we don't make duplicate calls
    if (device.thermostat?.roompriority?.deviceType === 'Thermostat' && device.deviceModel === 'T9-T10') {
      this.doRoomUpdate
        .pipe(
          tap(() => {
            this.roomUpdateInProgress = true
          }),
          debounceTime(this.devicePushRate * 500),
        )
        .subscribe(async () => {
          try {
            await this.pushRoomChanges()
          } catch (e: any) {
            const action = 'pushRoomChanges'
            if (this.device.retry) {
              // Refresh the status from the API
              interval(5000)
                .pipe(skipWhile(() => this.thermostatUpdateInProgress))
                .pipe(take(1))
                .subscribe(async () => {
                  await this.pushRoomChanges()
                })
            }
            this.resideoAPIError(e, action)
            this.platform.refreshAccessToken()
            this.apiError(e)
          }
          this.roomUpdateInProgress = false
          // Refresh the status from the API
          interval(5000)
            .pipe(skipWhile(() => this.thermostatUpdateInProgress))
            .pipe(take(1))
            .subscribe(async () => {
              await this.refreshStatus()
            })
        })
    }
    this.doThermostatUpdate
      .pipe(
        tap(() => {
          this.thermostatUpdateInProgress = true
        }),
        debounceTime(this.devicePushRate * 1000),
      )
      .subscribe(async () => {
        try {
          await this.pushChanges()
        } catch (e: any) {
          const action = 'pushChanges'
          if (this.device.retry) {
            // Refresh the status from the API
            interval(5000)
              .pipe(skipWhile(() => this.thermostatUpdateInProgress))
              .pipe(take(1))
              .subscribe(async () => {
                await this.pushChanges()
              })
          }
          this.resideoAPIError(e, action)
          this.platform.refreshAccessToken()
          this.apiError(e)
        }
        this.thermostatUpdateInProgress = false
        // Refresh the status from the API
        interval(15000)
          .pipe(skipWhile(() => this.thermostatUpdateInProgress))
          .pipe(take(1))
          .subscribe(async () => {
            await this.refreshStatus()
          })
      })
    if (device.settings?.fan && !device.thermostat?.hide_fan) {
      this.doFanUpdate
        .pipe(
          tap(() => {
            this.fanUpdateInProgress = true
          }),
          debounceTime(this.devicePushRate * 1000),
        )
        .subscribe(async () => {
          try {
            await this.pushFanChanges()
          } catch (e: any) {
            const action = 'pushFanChanges'
            if (this.device.retry) {
              // Refresh the status from the API
              interval(5000)
                .pipe(skipWhile(() => this.thermostatUpdateInProgress))
                .pipe(take(1))
                .subscribe(async () => {
                  await this.pushFanChanges()
                })
            }
            this.resideoAPIError(e, action)
            this.platform.refreshAccessToken()
            this.apiError(e)
          }
          this.fanUpdateInProgress = false
          // Refresh the status from the API
          interval(5000)
            .pipe(skipWhile(() => this.thermostatUpdateInProgress))
            .pipe(take(1))
            .subscribe(async () => {
              await this.refreshStatus()
            })
        })
    }
  }

  /**
   * Parse the device status from the Resideo api
   */
  async parseStatus(): Promise<void> {
    this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} parseStatus`)
    if (this.device.units === 'Fahrenheit') {
      this.Thermostat.TemperatureDisplayUnits = this.hap.Characteristic.TemperatureDisplayUnits.FAHRENHEIT
      this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} parseStatus TemperatureDisplayUnits: ${this.hap.Characteristic.TemperatureDisplayUnits.FAHRENHEIT}`)
    }
    if (this.device.units === 'Celsius') {
      this.Thermostat.TemperatureDisplayUnits = this.hap.Characteristic.TemperatureDisplayUnits.CELSIUS
      this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} parseStatus TemperatureDisplayUnits: ${this.hap.Characteristic.TemperatureDisplayUnits.CELSIUS}`)
    }

    this.Thermostat.CurrentTemperature = toCelsius(this.device.indoorTemperature!, Number(this.Thermostat.TemperatureDisplayUnits))
    this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} parseStatus CurrentTemperature: ${toCelsius(this.device.indoorTemperature!, Number(this.Thermostat.TemperatureDisplayUnits))}`)

    if (this.device.indoorHumidity) {
      if (this.HumiditySensor) {
        this.HumiditySensor.CurrentRelativeHumidity = this.device.indoorHumidity
        this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} parseStatus CurrentRelativeHumidity: ${this.HumiditySensor.CurrentRelativeHumidity}`)
      }
    }

    if (this.device.changeableValues!.heatSetpoint > 0) {
      this.Thermostat.HeatingThresholdTemperature = toCelsius(this.device.changeableValues!.heatSetpoint, Number(this.Thermostat.TemperatureDisplayUnits))
      this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} parseStatus HeatingThresholdTemperature: ${toCelsius(this.device.changeableValues!.heatSetpoint, Number(this.Thermostat.TemperatureDisplayUnits))}`)
    }

    if (this.device.changeableValues!.coolSetpoint > 0) {
      this.Thermostat.CoolingThresholdTemperature = toCelsius(this.device.changeableValues!.coolSetpoint, Number(this.Thermostat.TemperatureDisplayUnits))
      this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} parseStatus CoolingThresholdTemperature: ${toCelsius(this.device.changeableValues!.coolSetpoint, Number(this.Thermostat.TemperatureDisplayUnits))}`)
    }

    this.Thermostat.TargetHeatingCoolingState = HomeKitModes[this.device.changeableValues!.mode]
    this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} parseStatus TargetHeatingCoolingState: ${HomeKitModes[this.device.changeableValues!.mode]}`)

    /**
     * The CurrentHeatingCoolingState is either 'Heat', 'Cool', or 'Off'
     * CurrentHeatingCoolingState =  OFF = 0, HEAT = 1, COOL = 2
     */
    switch (this.device.operationStatus!.mode) {
      case 'Heat':
        this.Thermostat.CurrentHeatingCoolingState = this.hap.Characteristic.CurrentHeatingCoolingState.HEAT
        this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} parseStatus Currently Mode (HEAT): ${this.device.operationStatus!.mode}(${this.Thermostat.CurrentHeatingCoolingState})`)
        break
      case 'Cool':
        this.Thermostat.CurrentHeatingCoolingState = this.hap.Characteristic.CurrentHeatingCoolingState.COOL
        this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} parseStatus Currently Mode (COOL): ${this.device.operationStatus!.mode}(${this.Thermostat.CurrentHeatingCoolingState})`)
        break
      default:
        this.Thermostat.CurrentHeatingCoolingState = this.hap.Characteristic.CurrentHeatingCoolingState.OFF
        this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} parseStatus Currently Mode (OFF): ${this.device.operationStatus!.mode}(${this.Thermostat.CurrentHeatingCoolingState})`)
    }

    // Set the TargetTemperature value based on the current mode
    if (this.Thermostat.TargetHeatingCoolingState === this.hap.Characteristic.TargetHeatingCoolingState.HEAT) {
      if (this.device.changeableValues!.heatSetpoint > 0) {
        this.Thermostat.TargetTemperature = toCelsius(this.device.changeableValues!.heatSetpoint, Number(this.Thermostat.TemperatureDisplayUnits))
        this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} parseStatus TargetTemperature (HEAT): ${toCelsius(this.device.changeableValues!.heatSetpoint, Number(this.Thermostat.TemperatureDisplayUnits))})`)
      }
    } else {
      if (this.device.changeableValues) {
        if (this.device.changeableValues.coolSetpoint > 0) {
          this.Thermostat.TargetTemperature = toCelsius(this.device.changeableValues.coolSetpoint, Number(this.Thermostat.TemperatureDisplayUnits))
          this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} parseStatus TargetTemperature (OFF/COOL): ${toCelsius(this.device.changeableValues.coolSetpoint, Number(this.Thermostat.TemperatureDisplayUnits))})`)
        }
      }
    }

    // Set the Target Fan State
    if (this.device.settings?.fan && !this.device.thermostat?.hide_fan) {
      if (this.Fan) {
        if (this.fanStatus) {
          this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} fanStatus: ${JSON.stringify(this.fanStatus)}`)
          if (this.fanStatus.changeableValues.mode === 'Auto') {
            this.Fan.TargetFanState = this.hap.Characteristic.TargetFanState.AUTO
            this.Fan.Active = this.hap.Characteristic.Active.INACTIVE
          } else if (this.fanStatus.changeableValues.mode === 'On') {
            this.Fan.TargetFanState = this.hap.Characteristic.TargetFanState.MANUAL
            this.Fan.Active = this.hap.Characteristic.Active.ACTIVE
          } else if (this.fanStatus.changeableValues.mode === 'Circulate') {
            this.Fan.TargetFanState = this.hap.Characteristic.TargetFanState.MANUAL
            this.Fan.Active = this.hap.Characteristic.Active.INACTIVE
          }
        }
      }
    }

    // Set the Room Priority Status - T9 Only
    if (this.device.thermostat?.roompriority?.deviceType === 'Thermostat' && this.device.deviceModel === 'T9-T10') {
      this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} roomPriorityStatus: ${JSON.stringify(this.roomPriorityStatus)}`)
    }
  }

  /**
   * Asks the Resideo Home API for the latest device information
   */
  async refreshStatus(): Promise<void> {
    try {
      const device: any = await this.getDeviceStatus()
      const fanStatus: any = await this.getFanStatus()
      const roomPriorityStatus: any = await this.getRoomPriorityStatus()
      this.device = device
      this.fanStatus = fanStatus
      this.roomPriorityStatus = roomPriorityStatus
      this.parseStatus()
      this.updateHomeKitCharacteristics()
    } catch (e: any) {
      const action = 'refreshStatus'
      if (this.device.retry) {
        // Refresh the status from the API
        interval(5000)
          .pipe(skipWhile(() => this.thermostatUpdateInProgress))
          .pipe(take(1))
          .subscribe(async () => {
            await this.refreshStatus()
          })
      }
      this.resideoAPIError(e, action)
      this.apiError(e)
    }
  }

  private async getDeviceStatus() {
    const device: any = (
      await this.platform.axios.get(`${DeviceURL}/thermostats/${this.device.deviceID}`, {
        params: {
          locationId: this.location.locationID,
        },
      })
    ).data
    this.debugLog(`(refreshStatus) ${device.deviceClass} device: ${JSON.stringify(device)}`)
    this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} refreshStatus for ${this.device.name} from Resideo API: ${JSON.stringify(this.device.changeableValues)}`)
    return device
  }

  private async getRoomPriorityStatus() {
    if (this.device.thermostat?.roompriority?.deviceType === 'Thermostat' && this.device.deviceModel === 'T9-T10') {
      const roompriority = (
        await this.platform.axios.get(`${DeviceURL}/thermostats/${this.device.deviceID}/priority`, {
          params: {
            locationId: this.location.locationID,
          },
        })
      ).data
      this.debugLog(`Thermostat: ${this.accessory.displayName} Priority: ${JSON.stringify(roompriority.data)}`)
      const action = 'refreshRoomPriority'
      await this.statusCode(200, action)
      return roompriority
    }
  }

  private async getFanStatus() {
    if (this.device.settings?.fan && !this.device.thermostat?.hide_fan) {
      const fan: any = (
        await this.platform.axios.get(`${DeviceURL}/thermostats/${this.device.deviceID}/fan`, {
          params: {
            locationId: this.location.locationID,
          },
        })
      ).data
      const action = 'refreshFanStatus'
      await this.statusCode(200, action)
      this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} (refreshFanStatus) fanMode: ${JSON.stringify(fan)}`)
      this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} fanMode: ${JSON.stringify(fan)}`)
      this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} refreshStatus for ${this.device.name} Fan from Resideo Fan API: ${JSON.stringify(fan)}`)
      return fan
    }
    return null
  }

  /**
   * Pushes the requested changes to the Resideo API
   */
  async pushChanges(): Promise<void> {
    try {
      const payload = {} as payload
      // Only include mode on certain models
      switch (this.device.deviceModel) {
        case 'Unknown':
          this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} didn't send TargetHeatingCoolingState, Model:  ${this.device.deviceModel}`)
          break
        default:
          payload.mode = await this.ResideoMode()
          this.debugLog(
            `${this.device.deviceClass} ${this.accessory.displayName} send TargetHeatingCoolingState: ${payload.mode}`,
          )
      }

      // Only include thermostatSetpointStatus on certain models
      switch (this.device.deviceModel) {
        case 'Round':
          this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} didn't send thermostatSetpointStatus, Model: ${this.device.deviceModel}`)
          break
        default:
          this.pushChangesthermostatSetpointStatus()
          payload.thermostatSetpointStatus = this.thermostatSetpointStatus
          if (this.thermostatSetpointStatus === 'TemporaryHold') {
            this.warnLog(
              `${this.device.deviceClass} ${this.accessory.displayName} send thermostatSetpointStatus: `
              + `${payload.thermostatSetpointStatus}, Model: ${this.device.deviceModel}`,
            )
          } else {
            this.debugLog(
              `${this.device.deviceClass} ${this.accessory.displayName} send thermostatSetpointStatus: `
              + `${payload.thermostatSetpointStatus}, Model: ${this.device.deviceModel}`,
            )
          }
      }

      switch (this.device.deviceModel) {
        case 'Round':
        case 'D6':
          if (this.deviceLogging.includes('debug')) {
            this.warnLog(`${this.device.deviceClass} ${this.accessory.displayName} set autoChangeoverActive, Model: ${this.device.deviceModel}`)
          }
          // for Round  the 'Auto' feature is enabled via the special mode so only flip this bit when
          // the heating/cooling state is set to  `Auto
          if (this.Thermostat.TargetHeatingCoolingState === this.hap.Characteristic.TargetHeatingCoolingState.AUTO) {
            payload.autoChangeoverActive = true
            this.debugLog(
              `${this.device.deviceClass} ${this.accessory.displayName} Heating/Cooling state set to Auto for`
              + ` Model: ${this.device.deviceModel}, Force autoChangeoverActive: ${payload.autoChangeoverActive}`,
            )
          } else {
            payload.autoChangeoverActive = this.device.changeableValues?.autoChangeoverActive
            this.debugLog(
              `${this.device.deviceClass} ${this.accessory.displayName} Heating/cooling state not set to Auto for`
              + ` Model: ${this.device.deviceModel}, Using device setting`
              + ` autoChangeoverActive: ${this.device.changeableValues!.autoChangeoverActive}`,
            )
          }
          break
        case 'Unknown':
          this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} do not send autoChangeoverActive, Model: ${this.device.deviceModel}`)
          break
        default:
          payload.autoChangeoverActive = this.device.changeableValues!.autoChangeoverActive
          this.debugLog(
            `${this.device.deviceClass} ${this.accessory.displayName} set autoChangeoverActive to ${this.device.changeableValues!.autoChangeoverActive} for Model: ${this.device.deviceModel}`,
          )
      }

      switch (this.device.deviceModel) {
        case 'Unknown':
          this.errorLog(JSON.stringify(this.device))
          payload.thermostatSetpoint = toFahrenheit(Number(this.Thermostat.TargetTemperature), Number(this.Thermostat.TemperatureDisplayUnits))
          switch (this.device.units) {
            case 'Fahrenheit':
              payload.unit = 'Fahrenheit'
              break
            case 'Celsius':
              payload.unit = 'Celsius'
              break
          }
          this.successLog(
            `${this.device.deviceClass} ${this.accessory.displayName} sent request to Resideo API thermostatSetpoint: ${payload.thermostatSetpoint}, unit: ${payload.unit}`,
          )

          break
        default:
          // Set the heat and cool set point value based on the selected mode
          switch (this.Thermostat.TargetHeatingCoolingState) {
            case this.hap.Characteristic.TargetHeatingCoolingState.HEAT:
              payload.heatSetpoint = toFahrenheit(Number(this.Thermostat.TargetTemperature), Number(this.Thermostat.TemperatureDisplayUnits))
              payload.coolSetpoint = toFahrenheit(Number(this.Thermostat.CoolingThresholdTemperature), Number(this.Thermostat.TemperatureDisplayUnits))
              this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} TargetHeatingCoolingState (HEAT): ${this.Thermostat.TargetHeatingCoolingState}, TargetTemperature: ${toFahrenheit(Number(this.Thermostat.TargetTemperature), Number(this.Thermostat.TemperatureDisplayUnits))} heatSetpoint, CoolingThresholdTemperature: ${toFahrenheit(Number(this.Thermostat.CoolingThresholdTemperature), Number(this.Thermostat.TemperatureDisplayUnits))} coolSetpoint`)
              break
            case this.hap.Characteristic.TargetHeatingCoolingState.COOL:
              payload.coolSetpoint = toFahrenheit(Number(this.Thermostat.TargetTemperature), Number(this.Thermostat.TemperatureDisplayUnits))
              payload.heatSetpoint = toFahrenheit(Number(this.Thermostat.HeatingThresholdTemperature), Number(this.Thermostat.TemperatureDisplayUnits))
              this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} TargetHeatingCoolingState (COOL): ${this.Thermostat.TargetHeatingCoolingState}, TargetTemperature: ${toFahrenheit(Number(this.Thermostat.TargetTemperature), Number(this.Thermostat.TemperatureDisplayUnits))} coolSetpoint, CoolingThresholdTemperature: ${toFahrenheit(Number(this.Thermostat.HeatingThresholdTemperature), Number(this.Thermostat.TemperatureDisplayUnits))} heatSetpoint`)
              break
            case this.hap.Characteristic.TargetHeatingCoolingState.AUTO:
              payload.coolSetpoint = toFahrenheit(Number(this.Thermostat.CoolingThresholdTemperature), Number(this.Thermostat.TemperatureDisplayUnits))
              payload.heatSetpoint = toFahrenheit(Number(this.Thermostat.HeatingThresholdTemperature), Number(this.Thermostat.TemperatureDisplayUnits))
              this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} TargetHeatingCoolingState (AUTO): ${this.Thermostat.TargetHeatingCoolingState}, CoolingThresholdTemperature: ${toFahrenheit(Number(this.Thermostat.CoolingThresholdTemperature), Number(this.Thermostat.TemperatureDisplayUnits))} coolSetpoint, HeatingThresholdTemperature: ${toFahrenheit(Number(this.Thermostat.HeatingThresholdTemperature), Number(this.Thermostat.TemperatureDisplayUnits))} heatSetpoint`)
              break
            default:
              payload.coolSetpoint = toFahrenheit(Number(this.Thermostat.CoolingThresholdTemperature), Number(this.Thermostat.TemperatureDisplayUnits))
              payload.heatSetpoint = toFahrenheit(Number(this.Thermostat.HeatingThresholdTemperature), Number(this.Thermostat.TemperatureDisplayUnits))
              this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} TargetHeatingCoolingState (OFF): ${this.Thermostat.TargetHeatingCoolingState}, CoolingThresholdTemperature: ${toFahrenheit(Number(this.Thermostat.CoolingThresholdTemperature), Number(this.Thermostat.TemperatureDisplayUnits))} coolSetpoint, HeatingThresholdTemperature: ${toFahrenheit(Number(this.Thermostat.HeatingThresholdTemperature), Number(this.Thermostat.TemperatureDisplayUnits))} heatSetpoint`)
          }
          this.successLog(`${this.device.deviceClass} ${this.accessory.displayName} set request (${JSON.stringify(payload)}) to Resideo API.`)
      }

      // Attempt to make the API request
      await this.platform.axios.post(`${DeviceURL}/thermostats/${this.device.deviceID}`, payload, {
        params: {
          locationId: this.location.locationID,
        },
      })
      const action = 'pushChanges'
      await this.statusCode(200, action)
      this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} pushChanges: ${JSON.stringify(payload)}`)
      await this.updateHomeKitCharacteristics()
    } catch (e: any) {
      const action = 'pushChanges'
      if (this.device.retry) {
        // Refresh the status from the API
        interval(5000)
          .pipe(skipWhile(() => this.thermostatUpdateInProgress))
          .pipe(take(1))
          .subscribe(async () => {
            await this.pushChanges()
          })
      }
      this.resideoAPIError(e, action)
      this.apiError(e)
    }
  }

  async ResideoMode() {
    let resideoMode: string
    switch (this.Thermostat.TargetHeatingCoolingState) {
      case this.hap.Characteristic.TargetHeatingCoolingState.HEAT:
        resideoMode = ResideoModes.Heat
        break
      case this.hap.Characteristic.TargetHeatingCoolingState.COOL:
        resideoMode = ResideoModes.Cool
        break
      case this.hap.Characteristic.TargetHeatingCoolingState.AUTO:
        resideoMode = ResideoModes.Auto
        break
      case this.hap.Characteristic.TargetHeatingCoolingState.OFF:
        resideoMode = ResideoModes.Off
        break
      default:
        resideoMode = 'Unknown'
        this.debugErrorLog(`${this.device.deviceClass} ${this.accessory.displayName} Unknown TargetHeatingCoolingState: ${this.Thermostat.TargetHeatingCoolingState}`)
    }
    return resideoMode
  }

  async pushChangesthermostatSetpointStatus(): Promise<void> {
    if (this.thermostatSetpointStatus) {
      this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} thermostatSetpointStatus config set to ${this.thermostatSetpointStatus}`)
    } else {
      this.thermostatSetpointStatus = 'PermanentHold'
      this.accessory.context.thermostatSetpointStatus = this.thermostatSetpointStatus
      this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} thermostatSetpointStatus config not set`)
    }
  }

  /**
   * Pushes the requested changes for Room Priority to the Resideo API
   */
  async pushRoomChanges(): Promise<void> {
    this.debugLog(`Thermostat Room Priority for ${this.accessory.displayName}
     Current Room: ${JSON.stringify(this.roomPriorityStatus.currentPriority.selectedRooms)},
     Changing Room: [${this.device.inBuiltSensorState!.roomId}]`)
    if (`[${this.device.inBuiltSensorState!.roomId}]` !== `[${this.roomPriorityStatus.currentPriority.selectedRooms}]`) {
      const payload = {
        currentPriority: {
          priorityType: this.device.thermostat?.roompriority?.priorityType,
        },
      } as any

      if (this.device.thermostat?.roompriority?.priorityType === 'PickARoom') {
        payload.currentPriority.selectedRooms = [this.device.inBuiltSensorState!.roomId]
      }

      /**
       * For "LCC-" devices only.
       * "NoHold" will return to schedule.
       * "TemporaryHold" will hold the set temperature until next schedule.
       * "PermanentHold" will hold the setpoint until user requests another change.
       */
      if (this.device.thermostat?.roompriority?.deviceType === 'Thermostat') {
        if (this.device.priorityType === 'FollowMe') {
          this.successLog(
            `Sending request for ${this.accessory.displayName} to Resideo API Priority Type: ${this.device.priorityType}, Built-in Occupancy Sensor(s) Will be used to set Priority Automatically`,
          )
        } else if (this.device.priorityType === 'WholeHouse') {
          this.successLog(`Sending request for ${this.accessory.displayName} to Resideo API Priority Type:` + ` ${this.device.priorityType}`)
        } else if (this.device.priorityType === 'PickARoom') {
          this.successLog(
            `Sending request for ${this.accessory.displayName} to Resideo API Room Priority: ${this.device.inBuiltSensorState!.roomName}, Priority Type: ${this.device.thermostat?.roompriority.priorityType}`,
          )
        }
        // Make the API request
        await this.platform.axios.put(`${DeviceURL}/thermostats/${this.device.deviceID}/priority`, payload, {
          params: {
            locationId: this.location.locationID,
          },
        })
        const action = 'pushRoomChanges'
        await this.statusCode(200, action)
        this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} pushRoomChanges: ${JSON.stringify(payload)}`)
      }
    }
  }

  /**
   * Updates the status for each of the HomeKit Characteristics
   */
  async updateHomeKitCharacteristics(): Promise<void> {
    if (this.Thermostat.TemperatureDisplayUnits === undefined) {
      this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} TemperatureDisplayUnits: ${this.Thermostat.TemperatureDisplayUnits}`)
    } else {
      this.Thermostat.Service.updateCharacteristic(this.hap.Characteristic.TemperatureDisplayUnits, Number(this.Thermostat.TemperatureDisplayUnits))
      this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} updateCharacteristic TemperatureDisplayUnits: ${this.Thermostat.TemperatureDisplayUnits}`)
    }
    if (this.Thermostat.CurrentTemperature === undefined) {
      this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} CurrentTemperature: ${this.Thermostat.CurrentTemperature}`)
    } else {
      this.Thermostat.Service.updateCharacteristic(this.hap.Characteristic.CurrentTemperature, this.Thermostat.CurrentTemperature)
      this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} updateCharacteristic CurrentTemperature: ${this.Thermostat.CurrentTemperature}`)
    }
    if (this.Thermostat.TargetTemperature === undefined) {
      this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} TargetTemperature: ${this.Thermostat.TargetTemperature}`)
    } else {
      this.Thermostat.Service.updateCharacteristic(this.hap.Characteristic.TargetTemperature, this.Thermostat.TargetTemperature)
      this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} updateCharacteristic TargetTemperature: ${this.Thermostat.TargetTemperature}`)
    }
    if (this.Thermostat.HeatingThresholdTemperature === undefined) {
      this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} HeatingThresholdTemperature: ${this.Thermostat.HeatingThresholdTemperature}`)
    } else {
      this.Thermostat.Service.updateCharacteristic(this.hap.Characteristic.HeatingThresholdTemperature, this.Thermostat.HeatingThresholdTemperature)
      this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} updateCharacteristic HeatingThresholdTemperature: ${this.Thermostat.HeatingThresholdTemperature}`)
    }
    if (this.Thermostat.CoolingThresholdTemperature === undefined) {
      this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} CoolingThresholdTemperature: ${this.Thermostat.CoolingThresholdTemperature}`)
    } else {
      this.Thermostat.Service.updateCharacteristic(this.hap.Characteristic.CoolingThresholdTemperature, this.Thermostat.CoolingThresholdTemperature)
      this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} updateCharacteristic CoolingThresholdTemperature: ${this.Thermostat.CoolingThresholdTemperature}`)
    }
    if (this.Thermostat.TargetHeatingCoolingState === undefined) {
      this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} TargetHeatingCoolingState: ${this.Thermostat.TargetHeatingCoolingState}`)
    } else {
      this.Thermostat.Service.updateCharacteristic(this.hap.Characteristic.TargetHeatingCoolingState, this.Thermostat.TargetHeatingCoolingState)
      this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} updateCharacteristic TargetHeatingCoolingState: ${this.Thermostat.TargetHeatingCoolingState}`)
    }
    if (this.Thermostat.CurrentHeatingCoolingState === undefined) {
      this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} CurrentHeatingCoolingState: ${this.Thermostat.CurrentHeatingCoolingState}`)
    } else {
      this.Thermostat.Service.updateCharacteristic(this.hap.Characteristic.CurrentHeatingCoolingState, this.Thermostat.CurrentHeatingCoolingState)
      this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} updateCharacteristic CurrentHeatingCoolingState: ${this.Thermostat.TargetHeatingCoolingState}`)
    }
    if (!this.device.thermostat?.hide_humidity) {
      if (this.device.indoorHumidity) {
        if (this.HumiditySensor?.CurrentRelativeHumidity === undefined) {
          this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} CurrentRelativeHumidity: ${this.HumiditySensor?.CurrentRelativeHumidity}`)
        } else {
          this.HumiditySensor.Service.updateCharacteristic(this.hap.Characteristic.CurrentRelativeHumidity, this.HumiditySensor.CurrentRelativeHumidity)
          this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} updateCharacteristic CurrentRelativeHumidity: ${this.HumiditySensor.CurrentRelativeHumidity}`)
        }
      }
    }
    if (!this.device.thermostat?.hide_fan) {
      if (this.device.settings?.fan) {
        if (this.Fan?.TargetFanState === undefined) {
          this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} Fan TargetFanState: ${this.Fan?.TargetFanState}`)
        } else {
          this.Fan.Service.updateCharacteristic(this.hap.Characteristic.TargetFanState, this.Fan.TargetFanState)
          this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} Fan updateCharacteristic TargetFanState: ${this.Fan.TargetFanState}`)
        }
        if (this.Fan?.Active === undefined) {
          this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} Fan Active: ${this.Fan?.Active}`)
        } else {
          this.Fan.Service.updateCharacteristic(this.hap.Characteristic.Active, this.Fan.Active)
          this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} Fan updateCharacteristic Active: ${this.Fan.Active}`)
        }
      }
    }
  }

  async apiError(e: any): Promise<void> {
    this.Thermostat.Service.updateCharacteristic(this.hap.Characteristic.TemperatureDisplayUnits, e)
    this.Thermostat.Service.updateCharacteristic(this.hap.Characteristic.CurrentTemperature, e)
    this.Thermostat.Service.updateCharacteristic(this.hap.Characteristic.TargetTemperature, e)
    this.Thermostat.Service.updateCharacteristic(this.hap.Characteristic.HeatingThresholdTemperature, e)
    this.Thermostat.Service.updateCharacteristic(this.hap.Characteristic.CoolingThresholdTemperature, e)
    this.Thermostat.Service.updateCharacteristic(this.hap.Characteristic.TargetHeatingCoolingState, e)
    this.Thermostat.Service.updateCharacteristic(this.hap.Characteristic.CurrentHeatingCoolingState, e)
    if (!this.device.thermostat?.hide_humidity) {
      if (this.device.indoorHumidity) {
        this.HumiditySensor?.Service.updateCharacteristic(this.hap.Characteristic.CurrentRelativeHumidity, e)
      }
    }
    if (!this.device.thermostat?.hide_fan) {
      if (this.device.settings?.fan) {
        this.Fan?.Service.updateCharacteristic(this.hap.Characteristic.TargetFanState, e)
        this.Fan?.Service.updateCharacteristic(this.hap.Characteristic.Active, e)
      }
    }
  }

  async getThermostatConfigSettings(accessory: PlatformAccessory, device: resideoDevice & devicesConfig) {
    if (this.thermostatSetpointStatus === undefined) {
      accessory.context.thermostatSetpointStatus = device.thermostat?.thermostatSetpointStatus
      this.thermostatSetpointStatus = accessory.context.thermostatSetpointStatus
      this.debugLog(`${device.deviceClass} ${accessory.displayName} thermostatSetpointStatus: ${this.thermostatSetpointStatus}`)
    }
  }

  async setTargetHeatingCoolingState(value: CharacteristicValue): Promise<void> {
    this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} Set TargetHeatingCoolingState: ${value}`)

    this.Thermostat.TargetHeatingCoolingState = value

    // Set the TargetTemperature value based on the selected mode
    if (this.Thermostat.TargetHeatingCoolingState === this.hap.Characteristic.TargetHeatingCoolingState.HEAT) {
      this.Thermostat.TargetTemperature = toCelsius(this.device.changeableValues!.heatSetpoint, Number(this.Thermostat.TemperatureDisplayUnits))
    } else {
      this.Thermostat.TargetTemperature = toCelsius(this.device.changeableValues!.coolSetpoint, Number(this.Thermostat.TemperatureDisplayUnits))
    }
    this.Thermostat.Service.updateCharacteristic(this.hap.Characteristic.TargetTemperature, this.Thermostat.TargetTemperature)
    if (this.device.thermostat?.roompriority?.deviceType === 'Thermostat' && this.device.deviceModel === 'T9-T10') {
      this.doRoomUpdate.next()
    }
    if (this.Thermostat.TargetHeatingCoolingState !== HomeKitModes[this.device.changeableValues!.mode]) {
      this.doThermostatUpdate.next()
    }
  }

  async setHeatingThresholdTemperature(value: CharacteristicValue): Promise<void> {
    this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} Set HeatingThresholdTemperature: ${value}`)
    this.Thermostat.HeatingThresholdTemperature = value
    this.doThermostatUpdate.next()
  }

  async setCoolingThresholdTemperature(value: CharacteristicValue): Promise<void> {
    this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} Set CoolingThresholdTemperature: ${value}`)
    this.Thermostat.CoolingThresholdTemperature = value
    this.doThermostatUpdate.next()
  }

  async setTargetTemperature(value: CharacteristicValue): Promise<void> {
    this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} Set TargetTemperature: ${value}`)
    this.Thermostat.TargetTemperature = value
    this.doThermostatUpdate.next()
  }

  async setTemperatureDisplayUnits(value: CharacteristicValue): Promise<void> {
    this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} Set TemperatureDisplayUnits: ${value}`)
    this.warnLog('Changing the Hardware Display Units from HomeKit is not supported.')

    this.Thermostat.TemperatureDisplayUnits = this.device.units === 'Celsius'
      ? this.hap.Characteristic.TemperatureDisplayUnits.CELSIUS
      : this.hap.Characteristic.TemperatureDisplayUnits.FAHRENHEIT

    // change the temp units back to the one the Resideo API said the thermostat was set to
    setTimeout(() => {
      this.Thermostat.Service.updateCharacteristic(this.hap.Characteristic.TemperatureDisplayUnits, Number(this.Thermostat.TemperatureDisplayUnits))
    }, 100)
  }

  /**
   * Handle requests to set the "Programmable Switch Output State" characteristic
   */
  handleProgrammableSwitchOutputStateSet(value: CharacteristicValue) {
    this.debugLog('Triggered SET ProgrammableSwitchOutputState:', value)
  }

  /**
   * Pushes the requested changes for Fan to the Resideo API
   */
  async pushFanChanges(): Promise<void> {
    let payload = {
      mode: 'Auto', // default to Auto
    }
    if (this.device.settings?.fan && !this.device.thermostat?.hide_fan) {
      this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} TargetFanState: ${this.Fan?.TargetFanState}, Active: ${this.Fan?.Active}`)

      if (this.Fan?.TargetFanState === this.hap.Characteristic.TargetFanState.AUTO) {
        payload = {
          mode: 'Auto',
        }
      } else if (
        this.Fan?.TargetFanState === this.hap.Characteristic.TargetFanState.MANUAL
        && this.Fan?.Active === this.hap.Characteristic.Active.ACTIVE
      ) {
        payload = {
          mode: 'On',
        }
      } else if (
        this.Fan?.TargetFanState === this.hap.Characteristic.TargetFanState.MANUAL
        && this.Fan?.Active === this.hap.Characteristic.Active.INACTIVE
      ) {
        payload = {
          mode: 'Circulate',
        }
      }

      this.successLog(`Sending request for ${this.accessory.displayName} to Resideo API Fan Mode: ${payload.mode}`)
      // Make the API request
      await this.platform.axios.post(`${DeviceURL}/thermostats/${this.device.deviceID}/fan`, payload, {
        params: {
          locationId: this.location.locationID,
        },
      })
      const action = 'pushFanChanges'
      await this.statusCode(200, action)

      this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} pushChanges: ${JSON.stringify(payload)}`)
    }
  }

  /**
   * Updates the status for each of the HomeKit Characteristics
   */
  async setActive(value: CharacteristicValue): Promise<void> {
    this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} Set Active: ${value}`)
    this.Fan!.Active = value
    this.doFanUpdate.next()
  }

  async setTargetFanState(value: CharacteristicValue): Promise<void> {
    this.debugLog(`${this.device.deviceClass} ${this.accessory.displayName} Set TargetFanState: ${value}`)
    this.Fan!.TargetFanState = value
    this.doFanUpdate.next()
  }
}
