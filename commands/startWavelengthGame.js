import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";

export function createWavelengthLobbyEmbed(host, participants) {
  const participantNames = Array.from(participants.values())
    .map((user) => user.username)
    .join("\n");
  return new EmbedBuilder()
    .setColor(0x0099ff)
    .setTitle("📊 Wavelength Game Lobby")
    .setDescription(
      `**Host:** ${host.username}\n\nClick "Join Game" to play! The host can start the game when everyone is in.\n\n**Participants (${participants.size}):**\n${participantNames || "None yet"}`
    )
    .setFooter({ text: "You need at least 2 players to start." });
}

export default {
  data: new SlashCommandBuilder()
    .setName("startwavelength")
    .setDescription("Starts a new game of Wavelength"),

  async execute(interaction, activeGames, threadToGameMap) {
    const { channelId, user: host } = interaction;

    if (activeGames.has(channelId)) {
      return interaction.reply({
        content: "A game is already running in this channel!",
        ephemeral: true,
      });
    }

    const participants = new Map();
    participants.set(host.id, host);

    const game = {
      hostId: host.id,
      channelId: channelId,
      participants: participants,
      answers: new Map(),
      votes: new Map(),
      state: "lobby",
      extrema: null,
      lobbyMessage: null,
      answerTimeout: null,
      voteTimeout: null,
      roundNumber: 0,
      activeThreads: new Map(),
    };

    const embed = createWavelengthLobbyEmbed(host, participants);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("joinGame")
        .setLabel("Join Game")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("startGame")
        .setLabel("Start Game")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("leaveGame")
        .setLabel("Leave Game")
        .setStyle(ButtonStyle.Secondary)
    );

    const lobbyMessage = await interaction.reply({
      embeds: [embed],
      components: [row],
      fetchReply: true,
    });
    game.lobbyMessage = lobbyMessage;
    activeGames.set(channelId, game);
  },
};
