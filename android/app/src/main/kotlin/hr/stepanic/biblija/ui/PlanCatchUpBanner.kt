package hr.stepanic.biblija.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import hr.stepanic.biblija.AppViewModel
import hr.stepanic.biblija.PlanCatchUpOffer

/** Ponuda da se dani kanonskog plana prije linearnog kursora označe pročitanima, kao toast na webu. */
@Composable
fun PlanCatchUpBanner(vm: AppViewModel, offer: PlanCatchUpOffer, modifier: Modifier = Modifier) {
    val palette = LocalPalette.current
    val shape = RoundedCornerShape(12.dp)
    Column(
        modifier
            .widthIn(max = 560.dp)
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 10.dp)
            .shadow(10.dp, shape)
            .clip(shape)
            .background(palette.surface)
            .border(1.dp, palette.accent.copy(alpha = 0.4f), shape)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            "BIBLIJA 365 — KANONSKI REDOM",
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Bold,
            color = palette.accent,
        )
        Text(offer.question, style = MaterialTheme.typography.bodyMedium, color = palette.text)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { vm.acceptPlanCatchUp() }, colors = ButtonDefaults.buttonColors(containerColor = palette.accent)) {
                Icon(Icons.Filled.Check, contentDescription = null)
                Spacer(Modifier.size(6.dp))
                Text("Označi")
            }
            OutlinedButton(onClick = { vm.dismissPlanCatchUp() }) {
                Icon(Icons.Filled.Close, contentDescription = null)
                Spacer(Modifier.size(6.dp))
                Text("Ne")
            }
        }
    }
}
