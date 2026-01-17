import express from "express";
const router = express.Router();
// Logout route
router.post("/logout", async (req, res) => {
  try {
    await res.clearCookie("authToken", {
      httpOnly: false,
      secure: false,
      sameSite: "lax",
      path: "/",
    });
    res.status(200).json({ message: "Logout successful" });
  } catch (error) {
    console.error("Error during logout:", error);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
