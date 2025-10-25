import { SlashCommandBuilder } from "discord.js";

export default {
  data: new SlashCommandBuilder()
    .setName("stopgame")
    .setDescription("Stops the current game in this channel"),

  async execute(interaction, activeGames) {
    const game = activeGames.get(interaction.channelId);

    if (!game) {
      return interaction.reply({
        content: "There is no game running in this channel.",
        ephemeral: true,
      });
    }

    // Clear any running timeouts
    if (game.answerTimeout) clearTimeout(game.answerTimeout);
    if (game.voteTimeout) clearTimeout(game.voteTimeout);

    activeGames.delete(interaction.channelId);

    // Try to edit the original lobby message, or just send a new message
    try {
      await game.lobbyMessage.edit({
        content: "This game was manually stopped.",
        embeds: [],
        components: [],
      });
    } catch (error) {
      console.error("Could not edit lobby message on stop:", error);
    }

    return interaction.reply({
      content: "The game has been stopped.",
      ephemeral: true,
    });
  },
};
