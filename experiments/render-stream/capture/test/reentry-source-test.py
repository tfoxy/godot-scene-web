#!/usr/bin/env python3
"""Source-level checks for the engine callback's queue gate and node-map lifetime."""
from pathlib import Path
import os
import re
import unittest

SOURCE = Path(os.environ.get('RS_ADOPT_SOURCE', str(Path(__file__).resolve().parents[1] / 'src/rs_adopt.cpp'))).read_text()

class ReentrySource(unittest.TestCase):
    def test_hook_only_inserts_under_existing_lock_when_tag_on_and_not_sabotaged(self):
        hook = SOURCE.split('void node_added_call(', 1)[1].split('void *scene_tree()', 1)[0]
        self.assertRegex(hook, r'std::lock_guard<std::mutex> lock\(g_node_mutex\);\s*'
                         r'g_item_nodes\[rid\] = id;\s*'
                         r'if \(g_tag_active.load\(std::memory_order_seq_cst\) && !g_tag_no_reentry\) '
                         r'\{\s*g_tag_entered.insert\(rid\);\s*\}')
        self.assertEqual(hook.count('g_tag_entered.insert'), 1)
        self.assertEqual(hook.count('lock(g_node_mutex)'), 1)

    def test_arm_release_frees_entered_allocation(self):
        release = SOURCE.split('std::size_t adopt_release()', 1)[1]
        self.assertIn('std::unordered_set<std::uint64_t>().swap(g_tag_entered);', release)

    def test_every_map_clear_clears_entered(self):
        clears = re.findall(r'g_item_nodes.clear\(\);\s*g_tag_entered.clear\(\);', SOURCE)
        self.assertEqual(len(clears), SOURCE.count('g_item_nodes.clear();'))
        self.assertGreater(len(clears), 0)

    def test_prune_erases_dead_and_unmapped_rids(self):
        prune = SOURCE.split('void node_map_prune() {', 1)[1].split('std::string string_of', 1)[0]
        self.assertRegex(prune, r'object_get_instance_from_id\(it->second\) == nullptr\) '
                         r'\{\s*g_tag_entered.erase\(it->first\);\s*it = g_item_nodes.erase\(it\);')
        self.assertIn('g_item_nodes.count(*it) == 0 ? g_tag_entered.erase(it)', prune)

    def test_tag_off_clears_entered(self):
        off = SOURCE.split('g_tag_active.store(false, std::memory_order_seq_cst);', 1)[1]
        self.assertRegex(off, r'^\s*\{\s*std::lock_guard<std::mutex> lock\(g_node_mutex\);'
                         r'\s*g_tag_entered.clear\(\);')

    def test_reentry_requires_a_node_still_in_tree(self):
        identity = SOURCE.split('bool item_identity(', 1)[1].split('void tag_prune_map()', 1)[0]
        self.assertRegex(identity, r'if \(reentry\) \{\s*std::uint8_t inside = 0;\s*'
                         r'ptrcall\(kNodeIsInsideTree, node, nullptr, &inside\);\s*'
                         r'if \(inside == 0\) \{\s*return false;')

    def test_drain_reuses_set(self):
        drain = SOURCE.split('void tag_take_entered(', 1)[1].split('void tag_set_query', 1)[0]
        self.assertRegex(drain, r'out->clear\(\);\s*std::lock_guard<std::mutex> '
                         r'lock\(g_node_mutex\);\s*out->swap\(g_tag_entered\);')

if __name__ == '__main__':
    unittest.main()
