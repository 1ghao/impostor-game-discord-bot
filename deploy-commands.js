import { REST, Routes } from "discord.js";
import { SlashCommandBuilder } from "@discordjs/builders";
import dotenv from "dotenv";
dotenv.config();

const commands = [
  new SlashCommandBuilder()
    .setName("startimpostor")
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
  new SlashCommandBuilder()
    .setName("stopgame")
    .setDescription("Stops the current game in this channel"),
].map((command) => command.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log("Started refreshing application (/) commands.");

    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
      body: commands,
    });

    console.log("Successfully reloaded application (/) commands.");
  } catch (error) {
    console.error(error);
  }
})();
