import { SlashCommandBuilder } from "discord.js";

export default {
  data: new SlashCommandBuilder()
    .setName("stopgame")
    .setDescription("Stops the current game in this channel"),

  async execute(interaction, activeGames, threadToGameMap) {
    const game = activeGames.get(interaction.channelId);

    if (!game) {
      return interaction.reply({
        content: "There is no game running in this channel.",
        ephemeral: true,
      });
    }

    if (game.answerTimeout) clearTimeout(game.answerTimeout);
    if (game.voteTimeout) clearTimeout(game.voteTimeout);

    // === THREAD CLEANUP ===

    if (game && game.activeThreads) {
      for (const threadId of game.activeThreads.values()) {
        threadToGameMap.delete(threadId);
        try {
          const thread = await interaction.client.channels.fetch(threadId);
          await thread.delete("Game stopped by stop command.");
        } catch (e) {
          console.error("Could not stop game by command:", error);
        }
      }
    }

    activeGames.delete(interaction.channelId);

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
