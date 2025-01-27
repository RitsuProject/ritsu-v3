import { AnyGuildChannel, Message } from 'eris'
import { MessageCollector } from 'eris-collector'
import { TFunction } from 'i18next'
import NodeCache from 'node-cache'

import RoomHandler from '@handlers/RoomHandler'
import LevelHandler from '@handlers/LevelHandler'
import HintsHandler from '@handlers/HintsHandler'
import Themes from '@handlers/ThemesHandler'
import GameCommandHandler from '@handlers/GameCommandHandler'

import User from '@entities/User'
import Guilds, { GuildDocument } from '@entities/Guild'
import Rooms, { RoomDocument } from '@entities/Room'
import RoomLeaderboard from '@entities/RoomLeaderboard'

import GameOptions from '@interfaces/GameOptions'
import RitsuClient from '@structures/RitsuClient'
import UnreachableRepository from '@structures/errors/UnreachableRepository'

import getStreamFromURL from '@utils/GameUtils/GetStream'
import GameCollectorUtils from '@utils/GameUtils/GameCollectorUtils'
import getAnimeData from '@utils/GameUtils/GetAnimeData'
import handleError from '@utils/GameUtils/HandleError'
import GameEmbedFactory from '@factories/GameEmbedFactory'

/**
 * GameHandler
 * @description Main core of the game
 */
export default class GameHandler {
  public themesCache: NodeCache
  constructor(
    public message: Message,
    public client: RitsuClient,
    public gameOptions: GameOptions,
    public t: TFunction
  ) {
    this.message = message
    this.client = client
    this.t = t
    this.gameOptions = gameOptions
    this.themesCache = new NodeCache()
  }

  async initGame() {
    const guild = await Guilds.findById(this.message.guildID)
    if (!guild) return

    await this.startNewRound(guild).catch(
      (err: Error | UnreachableRepository) => {
        handleError(this.message, this.t, err)
      }
    )
  }

  async startNewRound(guild: GuildDocument) {
    const voiceChannelID = this.message.member.voiceState.channelID

    if (!voiceChannelID) {
      const oldRoomExists = await Rooms.exists({ _id: this.message.guildID })
      if (oldRoomExists) {
        this.client.leaveVoiceChannel(voiceChannelID)
        return this.message.channel.createMessage(
          this.t('game:errors.noUsersInTheVoiceChannel')
        )
      }
      return this.message.channel.createMessage(
        this.t('game:errors.noVoiceChannel')
      )
    }

    const discordGuild = this.client.guilds.get(this.message.guildID)
    const voiceChannel = discordGuild.channels.get(voiceChannelID)
    const isSingleplayer = this.isSinglePlayer(voiceChannel)

    const roomHandler = new RoomHandler(this.message, isSingleplayer)
    const room = await roomHandler.handleRoom()

    // Create our EmbedFactory instance to make super cute embeds.
    const gameEmbedFactory = new GameEmbedFactory(
      this.gameOptions,
      isSingleplayer,
      this.t
    )

    // If it is the first round, will send the starting the match embed.
    if (room.currentRound === 1) {
      const preparingMatchEmbed = gameEmbedFactory.preparingMatch()

      void this.message.channel.createMessage({ embed: preparingMatchEmbed })
    } else {
      const startingNextRoundEmbed = gameEmbedFactory.startingNextRound()

      void this.message.channel.createMessage({ embed: startingNextRoundEmbed })
    }

    const themes = new Themes(this.message, this.gameOptions, this.themesCache)
    const theme = await themes.getTheme()

    const stream = await getStreamFromURL(theme.link).catch(() => {
      throw new Error(this.t('game:errors.unableToLoadStream'))
    })

    const user = await User.findById(this.message.author.id)
    const animeData = await getAnimeData(theme.name, theme.malId)
    const hintsHandler = new HintsHandler(animeData, this.t)

    guild.rolling = true
    await guild.save()

    const roundStartedEmbed = gameEmbedFactory.roundStarted(room.currentRound)
    void this.message.channel.createMessage({ embed: roundStartedEmbed })

    const answerFilter = (msg: Message) =>
      GameCollectorUtils.isAnswer(animeData, msg)

    const gameCommandFilter = (msg: Message) =>
      GameCollectorUtils.isFakeCommand(guild.prefix, msg)

    const gameCommandCollector = new MessageCollector(
      this.client,
      this.message.channel,
      gameCommandFilter,
      {
        time: this.gameOptions.time,
      }
    )

    const answerCollector = new MessageCollector(
      this.client,
      this.message.channel,
      answerFilter,
      {
        time: this.gameOptions.time,
      }
    )

    gameCommandCollector.on('collect', (msg: Message) => {
      const gameCommandHandler = new GameCommandHandler(
        this.client,
        this.message,
        this.t,
        guild.prefix
      )
      const command = msg.content.trim()

      switch (command) {
        case `${guild.prefix}stop`: {
          void gameCommandHandler.handleStopCommand(room, answerCollector)
          break
        }
        case `${guild.prefix}hint`: {
          void gameCommandHandler.handleHintCommand(user, hintsHandler)
          break
        }
      }
    })

    answerCollector.on('collect', (msg: Message) => {
      void GameCollectorUtils.handleCollect(this.t, room, msg)
    })

    answerCollector.on(
      'end',
      (_, stopReason) =>
        void (async () => {
          if (stopReason === 'forceFinished') {
            await this.handleFinish(room, voiceChannelID, isSingleplayer, true)
            await this.clearData(room, guild)
            return
          }

          const answerers =
            room.answerers.length > 0
              ? room.answerers.map((id) => `<@${id}>`).join(', ')
              : this.t('utils:nobody')

          const answerEmbed = await gameEmbedFactory.answerEmbed(
            theme,
            animeData
          )

          await this.message.channel.createMessage('The answer is...')
          await this.message.channel.createMessage({ embed: answerEmbed })

          await this.message.channel.createMessage(
            this.t('game:winners', {
              users: answerers,
            })
          )

          // Handle level/xp for each of the answerers.
          room.answerers.forEach((id) => {
            void this.bumpScore(id)
            void this.handleLevel(id)
          })

          // If all rounds is over, finish the game, otherwise, start a new round.
          if (room.currentRound >= this.gameOptions.rounds) {
            await this.handleFinish(room, voiceChannelID, isSingleplayer, false)
            await this.clearData(room, guild)

            void this.message.channel.createMessage(this.t('game:roundEnded'))
          } else {
            void this.startNewRound(guild).catch((err) => {
              handleError(this.message, this.t, err)
            })
          }
        })()
    )

    void this.playTheme(voiceChannelID, stream)
  }

  async handleFinish(
    room: RoomDocument,
    voiceChannelID: string,
    isSinglePlayer: boolean,
    force: boolean
  ) {
    if (!force) {
      const matchWinner = await this.getMatchWinner(isSinglePlayer)
      if (matchWinner) {
        const winnerUser = await User.findById(matchWinner._id)
        const levelHandler = new LevelHandler()

        const newStats = await levelHandler.handleLevelByMode(
          winnerUser._id,
          this.gameOptions.mode
        )

        // TODO (#99): Show the final leaderboard when the last round end.

        void this.message.channel.createMessage(
          `Congrats <@${winnerUser._id}>! You won the match! ${newStats.xp} XP`
        )
      }
    }
    this.client.leaveVoiceChannel(voiceChannelID)
  }

  async getMatchWinner(isSinglePlayer: boolean) {
    const leaderboards = await RoomLeaderboard.find({
      guildId: this.message.guildID,
    })
    // Return a false boolean if there no leaderboard (indicating that nobody won)
    if (!leaderboards) return false

    const scores = leaderboards.map((user) => {
      return user.score
    })

    const highestScore = Math.max(...scores)

    if (isSinglePlayer) {
      // Calculate half of the rounds.
      const halfRounds = this.gameOptions.rounds / 2
      // Round the half of the rounds number to the nearest integer
      const roundedHalfRounds = Math.round(halfRounds)

      // Score always are 1 number forward the number of won rounds.
      const wonRounds = highestScore - 1

      // If the user won rounds is not equal to the half of the rounds, return a false boolean (indicating that nobody won)
      if (roundedHalfRounds > wonRounds) return false
    }

    // Get the user with the highest score.
    const highestUser = await RoomLeaderboard.findOne({
      guildId: this.message.guildID,
      score: highestScore,
    })

    return highestUser
  }

  async clearData(room: RoomDocument, guild: GuildDocument) {
    const leaderboards = await RoomLeaderboard.find({
      guildId: this.message.guildID,
    })

    this.themesCache.del(this.themesCache.keys())
    guild.rolling = false
    leaderboards.map(async (board) => {
      await board.deleteOne()
    })

    await guild.save()
    await room.deleteOne()
  }

  isSinglePlayer(voiceChannel: AnyGuildChannel) {
    // If the specified channel is not type 2 (VoiceChannel), throw a error.
    if (voiceChannel.type !== 2) throw new Error('Invalid Channel Type')
    const voiceChannelMembers = voiceChannel.voiceMembers.filter((member) => {
      return member.id !== this.client.user.id // Ignore the bot
    })
    if (voiceChannelMembers.length === 1) return true
    return false
  }

  async bumpScore(userId: string) {
    const leaderboard = await RoomLeaderboard.findById(userId)
    if (leaderboard) {
      leaderboard.score = leaderboard.score + 1
      await leaderboard.save()
    }
  }

  async handleLevel(userId: string) {
    const user = await User.findById(userId)
    const levelHandler = new LevelHandler()
    const stats = await levelHandler.handleLevelByMode(
      userId,
      this.gameOptions.mode
    )
    user.xp = user.xp + stats.xp

    // If the new level is not equal to the user level, this means that the user level up!
    if (stats.level !== user.level) {
      void this.message.channel.createMessage(
        `Congratulations <@${userId}>! You just level up to **${stats.level}**!`
      )
    }
    await user.save()
  }

  playTheme(voiceChannel: string, stream: string) {
    this.client
      .joinVoiceChannel(voiceChannel)
      .then((connection) => {
        connection.play(stream)

        setTimeout(() => {
          connection.stopPlaying()
        }, this.gameOptions.time - 2000)
      })
      .catch((e: Error) => {
        throw new Error(`Failed to connect to the Voice Channel | ${e.message}`)
      })
  }
}
