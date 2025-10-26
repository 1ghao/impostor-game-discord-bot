import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";

export function createLobbyEmbed(host, participants) {
  const participantNames = Array.from(participants.values())
    .map((user) => user.username)
    .join("\n");
  return new EmbedBuilder()
    .setColor(0x0099ff)
    .setTitle("🕵️ Anime Impostor Game Lobby")
    .setDescription(
      `**Host:** ${host.username}\n\nClick "Join Game" to play! The host can start the game when everyone is in.\n\n**Participants (${participants.size}):**\n${participantNames || "None yet"}`
    )
    .setFooter({ text: "You need at least 3 players to start." });
}

export default {
  data: new SlashCommandBuilder()
    .setName("startgame")
    .setDescription("Starts a new game of Impostor")
    .addStringOption((option) =>
      option
        .setName("category")
        .setDescription(
          "Which question category do you want to play? (Default: Random)"
        )
        .setRequired(false)
        .addChoices(
          { name: "Random (default)", value: "random" },
          { name: "Anime Questions", value: "anime" },
          { name: "Character Questions", value: "character" }
        )
    ),

  async execute(interaction, activeGames, threadToGameMap) {
    const { channelId, user: host } = interaction;
    let category = interaction.options.getString("category");
    if (!category || category === "random") {
      category = "random";
    }

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
      category: category,
      impostorId: null,
      realQuestion: null,
      impostorQuestion: null,
      answers: new Map(),
      votes: new Map(),
      state: "lobby",
      lobbyMessage: null,
      answerTimeout: null,
      voteTimeout: null,
      roundNumber: 0,
      activeThreads: new Map(),
    };

    const embed = createLobbyEmbed(host, participants);

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
