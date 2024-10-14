import {
  AcknowledgePacketEvent,
  PacketEvent,
  SendPacketEvent,
  TimeoutPacketEvent,
  WriteAckEvent,
  PacketSendTable,
  PacketTimeoutTable,
  PacketWriteAckTable,
  Boolean,
  FeeType,
} from 'src/types'
import { DB } from '..'
import { In, WhereOptions, del, insert, select, update } from '../utils'
import { ConnectionController } from './connection'
import { Database } from 'better-sqlite3'
import { LCDClient } from 'src/lib/lcdClient'
import { PacketFeeController } from './packetFee'
import { FeeFilter } from 'src/lib/config'

export class PacketController {
  private static tableNamePacketSend = 'packet_send'
  private static tableNamePacketTimeout = 'packet_timeout'
  private static tableNamePacketWriteAck = 'packet_write_ack'

  public static async feedEvents(
    lcd: LCDClient,
    chainId: string,
    events: PacketEvent[]
  ): Promise<() => void> {
    const feedFns: (() => void)[] = []
    for (const event of events) {
      switch (event.type) {
        case 'send_packet':
          feedFns.push(await this.feedSendPacketEvent(lcd, chainId, event))
          break
        case 'write_acknowledgement':
          feedFns.push(await this.feedWriteAckEvent(lcd, chainId, event))
          break
        case 'acknowledge_packet':
          feedFns.push(
            await this.feedAcknowledgePacketEvent(lcd, chainId, event)
          )
          break
        case 'timeout_packet':
          feedFns.push(await this.feedTimeoutPacketEvent(lcd, chainId, event))
          break
      }
    }

    return () => {
      for (const fn of feedFns) {
        fn()
      }
    }
  }

  public static getSendPackets(
    chainId: string,
    height: number,
    timestamp: number,
    chainIdsWithFeeFilters: { chainId: string; feeFilter: FeeFilter }[],
    filter: PacketFilter = {},
    limit = 100
  ): PacketSendTable[] {
    const res: PacketSendTable[] = []

    // query for each chain id
    for (const {
      chainId: counterpartyChainId,
      feeFilter,
    } of chainIdsWithFeeFilters) {
      const wheres: WhereOptions<PacketSendTable>[] = []
      let custom = `(timeout_height > ${height} OR timeout_timestamp > ${timestamp})` // filter timeout packet
      if (feeFilter.recvFee && feeFilter.recvFee.length !== 0) {
        const conditions = feeFilter.recvFee.map(
          (v) =>
            `((SELECT amount FROM packet_fee WHERE chain_id = packet_send.src_chain_id AND channel_id = packet_send.src_channel_id AND sequence = packet_send.sequence AND fee_type = ${FeeType.RECV} AND denom = '${v.denom}') >= ${v.amount})`
        )
        custom += ` AND (${conditions.join(' OR ')})`
      }

      if (filter.connections) {
        // TODO: make this more efficientnet. filter connection by chain id
        wheres.push(
          ...filter.connections.map((conn) => ({
            in_progress: Boolean.FALSE,
            dst_chain_id: chainId,
            dst_connection_id: conn.connectionId,
            dst_channel_id: conn.channels ? In(conn.channels) : undefined,
            src_chain_id: counterpartyChainId,
            custom,
          }))
        )
      } else {
        wheres.push({
          in_progress: Boolean.FALSE,
          dst_chain_id: chainId,
          src_chain_id: counterpartyChainId,
          custom,
        })
      }

      res.push(
        ...select<PacketSendTable>(
          DB,
          this.tableNamePacketSend,
          wheres,
          { sequence: 'ASC' },
          limit - res.length
        )
      )
    }

    return res
  }

  public static getTimeoutPackets(
    chainId: string,
    height: number,
    timestamp: number,
    counterpartyChainIds: string[],
    feeFilter: FeeFilter,
    filter: PacketFilter = {},
    limit = 100
  ): PacketTimeoutTable[] {
    let custom = `((timeout_height < ${height} AND timeout_height != 0) OR timeout_timestamp < ${timestamp} AND timeout_timestamp != 0)` // filter timeout packet

    if (feeFilter.timeoutFee && feeFilter.timeoutFee.length !== 0) {
      const conditions = feeFilter.timeoutFee.map(
        (v) =>
          `((SELECT amount FROM packet_fee WHERE chain_id = packet_timeout.src_chain_id AND channel_id = packet_timeout.src_channel_id AND sequence = packet_timeout.sequence AND fee_type = ${FeeType.TIMEOUT} AND denom = '${v.denom}') >= ${v.amount})`
      )
      custom += ` AND (${conditions.join(' OR ')})`
    }

    const wheres: WhereOptions<PacketSendTable>[] = []

    if (filter.connections) {
      // TODO: make this more efficientnet. filter connection by chain id
      wheres.push(
        ...filter.connections.map((conn) => ({
          in_progress: Boolean.FALSE,
          src_chain_id: chainId,
          src_connection_id: conn.connectionId,
          src_channel_id: conn.channels ? In(conn.channels) : undefined,
          dst_chain_id: In(counterpartyChainIds),
          custom,
        }))
      )
    } else {
      wheres.push({
        in_progress: Boolean.FALSE,
        src_chain_id: chainId,
        dst_chain_id: In(counterpartyChainIds),
        custom,
      })
    }

    return select<PacketTimeoutTable>(
      DB,
      this.tableNamePacketTimeout,
      wheres,
      { sequence: 'ASC' },
      limit
    )
  }

  public static getWriteAckPackets(
    chainId: string,
    counterpartyChainIds: string[],
    feeFilter: FeeFilter,
    filter: PacketFilter = {},
    limit = 100
  ): PacketWriteAckTable[] {
    let custom = 'TRUE'

    if (feeFilter.ackFee && feeFilter.ackFee.length !== 0) {
      const conditions = feeFilter.ackFee.map(
        (v) =>
          `((SELECT amount FROM packet_fee WHERE chain_id = packet_write_ack.src_chain_id AND channel_id = packet_write_ack.src_channel_id AND sequence = packet_write_ack.sequence AND fee_type = ${FeeType.ACK} AND denom = '${v.denom}') >= ${v.amount})`
      )
      custom += ` AND (${conditions.join(' OR ')})`
    }

    const wheres: WhereOptions<PacketWriteAckTable>[] = []

    if (filter.connections) {
      wheres.push(
        ...filter.connections.map((conn) => ({
          in_progress: Boolean.FALSE,
          src_chain_id: chainId,
          src_connection_id: conn.connectionId,
          src_channel_id: conn.channels ? In(conn.channels) : undefined,
          dst_chain_id: In(counterpartyChainIds), // TODO: make this more efficientnet, like filter it on outside of this.
          custom,
        }))
      )
    } else {
      wheres.push({
        in_progress: Boolean.FALSE,
        src_chain_id: chainId,
        dst_chain_id: In(counterpartyChainIds),
        custom,
      })
    }

    return select<PacketWriteAckTable>(
      DB,
      this.tableNamePacketWriteAck,
      wheres,
      { sequence: 'ASC' },
      limit
    )
  }

  public static delSendPackets(packets: PacketSendTable[]) {
    if (packets.length === 0) return
    del<PacketSendTable>(
      DB,
      this.tableNamePacketSend,
      packets.map((packet) => ({
        dst_chain_id: packet.dst_chain_id,
        dst_connection_id: packet.dst_connection_id,
        dst_channel_id: packet.dst_channel_id,
        sequence: packet.sequence,
      }))
    )
  }

  public static delTimeoutPackets(packets: PacketTimeoutTable[]) {
    if (packets.length === 0) return
    del<PacketTimeoutTable>(
      DB,
      this.tableNamePacketTimeout,
      packets.map((packet) => ({
        src_chain_id: packet.src_chain_id,
        src_connection_id: packet.src_connection_id,
        src_channel_id: packet.src_channel_id,
        sequence: packet.sequence,
      }))
    )
  }

  public static delWriteAckPackets(packets: PacketWriteAckTable[]) {
    if (packets.length === 0) return
    del<PacketWriteAckTable>(
      DB,
      this.tableNamePacketWriteAck,
      packets.map((packet) => ({
        src_chain_id: packet.src_chain_id,
        src_connection_id: packet.src_connection_id,
        src_channel_id: packet.src_channel_id,
        sequence: packet.sequence,
      }))
    )
  }

  public static updateSendPacketInProgress(
    packet: PacketSendTable,
    inProgress = true
  ) {
    update<PacketSendTable>(
      DB,
      this.tableNamePacketSend,
      { in_progress: inProgress ? Boolean.TRUE : Boolean.FALSE },
      [
        {
          dst_chain_id: packet.dst_chain_id,
          dst_connection_id: packet.dst_connection_id,
          dst_channel_id: packet.dst_channel_id,
          sequence: packet.sequence,
        },
      ]
    )
  }

  public static updateTimeoutPacketInProgress(
    packet: PacketTimeoutTable,
    inProgress = true
  ) {
    update<PacketTimeoutTable>(
      DB,
      this.tableNamePacketTimeout,
      { in_progress: inProgress ? Boolean.TRUE : Boolean.FALSE },
      [
        {
          src_chain_id: packet.src_chain_id,
          src_connection_id: packet.src_connection_id,
          src_channel_id: packet.src_channel_id,
          sequence: packet.sequence,
        },
      ]
    )
  }

  public static updateWriteAckPacketInProgress(
    packet: PacketWriteAckTable,
    inProgress = true
  ) {
    update<PacketWriteAckTable>(
      DB,
      this.tableNamePacketWriteAck,
      { in_progress: inProgress ? Boolean.TRUE : Boolean.FALSE },
      [
        {
          src_chain_id: packet.src_chain_id,
          src_connection_id: packet.src_connection_id,
          src_channel_id: packet.src_channel_id,
          sequence: packet.sequence,
        },
      ]
    )
  }

  public static resetPacketInProgress(db?: Database) {
    db = db ?? DB
    update<PacketSendTable>(db, this.tableNamePacketSend, {
      in_progress: Boolean.FALSE,
    })
    update<PacketTimeoutTable>(db, this.tableNamePacketTimeout, {
      in_progress: Boolean.FALSE,
    })
    update<PacketWriteAckTable>(db, this.tableNamePacketWriteAck, {
      in_progress: Boolean.FALSE,
    })
  }

  private static async feedSendPacketEvent(
    lcd: LCDClient,
    chainId: string,
    event: SendPacketEvent
  ): Promise<() => void> {
    // get counterparty's info
    const connection = await ConnectionController.getConnection(
      lcd,
      chainId,
      event.packetInfo.connectionId
    )

    // add pakcet send on dst chain
    const packetSend: PacketSendTable = {
      dst_chain_id: connection.counterparty_chain_id,
      dst_connection_id: connection.counterparty_connection_id,
      dst_channel_id: event.packetInfo.dstChannel,
      sequence: Number(event.packetInfo.sequence),
      in_progress: Boolean.FALSE,
      is_ordered:
        'ORDER_ORDERED' === event.packetInfo.ordering
          ? Boolean.TRUE
          : Boolean.FALSE,
      height: event.packetInfo.height,
      dst_port: event.packetInfo.dstPort,
      src_chain_id: chainId,
      src_connection_id: event.packetInfo.connectionId,
      src_port: event.packetInfo.srcPort,
      src_channel_id: event.packetInfo.srcChannel,
      packet_data: event.packetInfo.data as string,
      timeout_height: Number(event.packetInfo.timeoutHeight),
      timeout_timestamp: Number(event.packetInfo.timeoutTimestamp),
      timeout_height_raw: event.packetInfo.timeoutHeightRaw,
      timeout_timestamp_raw: event.packetInfo.timeoutTimestampRaw,
    }

    // add packet timeout on source chain
    const packetTimeout: PacketTimeoutTable = {
      src_chain_id: chainId,
      src_connection_id: event.packetInfo.connectionId,
      src_channel_id: event.packetInfo.srcChannel,
      sequence: Number(event.packetInfo.sequence),
      in_progress: Boolean.FALSE,
      is_ordered:
        'ORDER_ORDERED' === event.packetInfo.ordering
          ? Boolean.TRUE
          : Boolean.FALSE,
      src_port: event.packetInfo.srcPort,
      dst_chain_id: connection.counterparty_chain_id,
      dst_connection_id: connection.counterparty_connection_id,
      dst_port: event.packetInfo.dstPort,
      dst_channel_id: event.packetInfo.dstChannel,
      packet_data: event.packetInfo.data as string,
      timeout_height: Number(event.packetInfo.timeoutHeight),
      timeout_timestamp: Number(event.packetInfo.timeoutTimestamp),
      timeout_height_raw: event.packetInfo.timeoutHeightRaw,
      timeout_timestamp_raw: event.packetInfo.timeoutTimestampRaw,
    }

    return () => {
      insert(DB, this.tableNamePacketSend, packetSend)
      insert(DB, this.tableNamePacketTimeout, packetTimeout)
    }
  }

  private static async feedWriteAckEvent(
    lcd: LCDClient,
    chainId: string,
    event: WriteAckEvent
  ): Promise<() => void> {
    // get counterparty's info
    const connection = await ConnectionController.getConnection(
      lcd,
      chainId,
      event.packetInfo.connectionId
    )

    // add packet write ack on src chain
    const packetWriteAck: PacketWriteAckTable = {
      src_chain_id: connection.counterparty_chain_id,
      src_connection_id: connection.counterparty_connection_id,
      src_channel_id: event.packetInfo.srcChannel,
      sequence: Number(event.packetInfo.sequence),
      in_progress: Boolean.FALSE,
      is_ordered:
        'ORDER_ORDERED' === event.packetInfo.ordering
          ? Boolean.TRUE
          : Boolean.FALSE,
      height: event.packetInfo.height,
      src_port: event.packetInfo.srcPort,
      dst_chain_id: chainId,
      dst_connection_id: event.packetInfo.connectionId,
      dst_port: event.packetInfo.dstPort,
      dst_channel_id: event.packetInfo.dstChannel,
      packet_data: event.packetInfo.data as string,
      ack: event.packetInfo.ack as string,
      timeout_height: Number(event.packetInfo.timeoutHeight),
      timeout_timestamp: Number(event.packetInfo.timeoutTimestamp),
      timeout_height_raw: event.packetInfo.timeoutHeightRaw,
      timeout_timestamp_raw: event.packetInfo.timeoutTimestampRaw,
    }
    return () => {
      // remove pakcet send
      del<PacketSendTable>(DB, this.tableNamePacketSend, [
        {
          dst_chain_id: chainId,
          dst_connection_id: event.packetInfo.connectionId,
          dst_channel_id: event.packetInfo.dstChannel,
          sequence: Number(event.packetInfo.sequence),
        },
      ])

      // remove packet fees
      PacketFeeController.removePacketFee(
        packetWriteAck.src_chain_id,
        packetWriteAck.src_channel_id,
        packetWriteAck.sequence,
        FeeType.RECV
      )
      PacketFeeController.removePacketFee(
        packetWriteAck.src_chain_id,
        packetWriteAck.src_channel_id,
        packetWriteAck.sequence,
        FeeType.TIMEOUT
      )

      insert(DB, this.tableNamePacketWriteAck, packetWriteAck)
    }
  }

  private static async feedAcknowledgePacketEvent(
    lcd: LCDClient,
    chainId: string,
    event: AcknowledgePacketEvent
  ): Promise<() => void> {
    // get counterparty's info
    const connection = await ConnectionController.getConnection(
      lcd,
      chainId,
      event.packetInfo.connectionId
    )

    return () => {
      // remove pakcet send
      del<PacketSendTable>(DB, this.tableNamePacketSend, [
        {
          dst_chain_id: connection.counterparty_chain_id,
          dst_connection_id: connection.counterparty_connection_id,
          dst_channel_id: event.packetInfo.dstChannel,
          sequence: Number(event.packetInfo.sequence),
        },
      ])

      // remove packet timeout
      del<PacketTimeoutTable>(DB, this.tableNamePacketSend, [
        {
          src_chain_id: chainId,
          src_connection_id: event.packetInfo.connectionId,
          src_channel_id: event.packetInfo.srcChannel,
          sequence: Number(event.packetInfo.sequence),
        },
      ])

      // remove packet write ack
      del<PacketWriteAckTable>(DB, this.tableNamePacketSend, [
        {
          src_chain_id: chainId,
          src_connection_id: event.packetInfo.connectionId,
          src_channel_id: event.packetInfo.srcChannel,
          sequence: Number(event.packetInfo.sequence),
        },
      ])

      // remove packet fees
      PacketFeeController.removePacketFee(
        chainId,
        event.packetInfo.srcChannel,
        event.packetInfo.sequence,
        FeeType.RECV
      )
      PacketFeeController.removePacketFee(
        chainId,
        event.packetInfo.srcChannel,
        event.packetInfo.sequence,
        FeeType.TIMEOUT
      )
      PacketFeeController.removePacketFee(
        chainId,
        event.packetInfo.srcChannel,
        event.packetInfo.sequence,
        FeeType.ACK
      )
    }
  }

  private static async feedTimeoutPacketEvent(
    lcd: LCDClient,
    chainId: string,
    event: TimeoutPacketEvent
  ): Promise<() => void> {
    // get counterparty's info
    const connection = await ConnectionController.getConnection(
      lcd,
      chainId,
      event.packetInfo.connectionId
    )
    return () => {
      // remove pakcet send
      del<PacketSendTable>(DB, this.tableNamePacketSend, [
        {
          dst_chain_id: connection.counterparty_chain_id,
          dst_connection_id: connection.counterparty_connection_id,
          dst_channel_id: event.packetInfo.dstChannel,
          sequence: Number(event.packetInfo.sequence),
        },
      ])

      // remove packet timeout
      del<PacketTimeoutTable>(DB, this.tableNamePacketSend, [
        {
          src_chain_id: chainId,
          src_connection_id: event.packetInfo.connectionId,
          src_channel_id: event.packetInfo.srcChannel,
          sequence: Number(event.packetInfo.sequence),
        },
      ])

      // remove packet fees
      PacketFeeController.removePacketFee(
        chainId,
        event.packetInfo.srcChannel,
        event.packetInfo.sequence,
        FeeType.RECV
      )
      PacketFeeController.removePacketFee(
        chainId,
        event.packetInfo.srcChannel,
        event.packetInfo.sequence,
        FeeType.TIMEOUT
      )
      PacketFeeController.removePacketFee(
        chainId,
        event.packetInfo.srcChannel,
        event.packetInfo.sequence,
        FeeType.ACK
      )
    }
  }
}

export interface PacketFilter {
  connections?: {
    connectionId: string
    channels?: string[] // if empty search all
  }[] // if empty search all
}
